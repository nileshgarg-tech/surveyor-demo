import { databaseError, getInternalStudy } from "@/lib/data";
import {
  classifyProlificStudyStatus,
  createProlificClient,
} from "@/lib/providers/prolific";
import {
  claimProviderOperation,
  evidenceRequestId,
  markProviderDispatched,
  recordProviderResult,
  requestFingerprint,
  safeError,
} from "@/lib/services/provider-events";
import { getServiceSupabase } from "@/lib/supabase/server";

const STATUS_FRESHNESS_MS = 15_000;

/** Persist provider evidence before any observation can release a recruiting slot. */
export async function syncRecruitmentStatus(studyId: string): Promise<void> {
  const study = await getInternalStudy(studyId);
  if (
    study.slot_state !== "held" ||
    study.budget_state !== "committed" ||
    typeof study.prolific_study_id !== "string" ||
    ["creating", "publishing", "reconciling", "pausing", "stopping", "deleting"].includes(
      String(study.operation_stage),
    )
  ) {
    return;
  }
  const checkedAt = typeof study.provider_status_checked_at === "string"
    ? Date.parse(study.provider_status_checked_at)
    : Number.NaN;
  if (Number.isFinite(checkedAt) && checkedAt > Date.now() - STATUS_FRESHNESS_MS) return;

  const bucket = Math.floor(Date.now() / STATUS_FRESHNESS_MS);
  const externalId = study.prolific_study_id;
  const operation = await claimProviderOperation({
    provider: "prolific",
    operation: "get_study_status",
    localOperationKey: `status:${studyId}:${bucket}`,
    studyId,
    requestFingerprint: requestFingerprint({ externalId, bucket }),
    sanitizedRequest: { purpose: "recruiting_slot_reconciliation" },
  });
  if (!operation.applied) return;

  try {
    await markProviderDispatched(operation.eventId);
    const result = await createProlificClient().getStudy(externalId);
    const disposition = classifyProlificStudyStatus(result.data.status);
    if (disposition === "blocked_unknown") {
      await recordProviderResult({
        eventId: operation.eventId,
        status: "ambiguous",
        effect: "unknown",
        response: { providerStatus: result.data.status },
        requestId: evidenceRequestId(result.evidence),
        externalResourceId: externalId,
        externalStatus: result.data.status,
        errorCode: "UNKNOWN_PROVIDER_STATUS",
        errorMessage: "Provider status requires reconciliation.",
      });
      return;
    }

    const nonRecruiting = disposition === "paid_non_recruiting";
    await recordProviderResult({
      eventId: operation.eventId,
      status: "succeeded",
      effect: nonRecruiting ? "non_recruiting" : "published_or_spend_possible",
      response: { providerStatus: result.data.status },
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: externalId,
      externalStatus: result.data.status,
    });
    if (nonRecruiting) {
      const { error } = await getServiceSupabase().rpc("release_study_slot", {
        p_study_id: studyId,
        p_provider_event_id: operation.eventId,
        p_reason: "provider_non_recruiting",
      });
      if (error) throw databaseError("Recruiting slot could not be released.", error);
      return;
    }

    const { error } = await getServiceSupabase()
      .from("studies")
      .update({
        prolific_status: result.data.status,
        provider_status_checked_at: new Date().toISOString(),
      })
      .eq("id", studyId)
      .eq("slot_state", "held");
    if (error) throw databaseError("Provider status could not be saved.", error);
  } catch (error) {
    await recordProviderResult({
      eventId: operation.eventId,
      status: "ambiguous",
      effect: "unknown",
      errorCode: "STATUS_CHECK_UNRESOLVED",
      errorMessage: safeError(error instanceof Error ? error.message : "Provider status check failed."),
    }).catch(() => undefined);
  }
}

export async function syncRecruitingStudies(limit: number): Promise<number> {
  const { data, error } = await getServiceSupabase()
    .from("studies")
    .select("id")
    .eq("slot_state", "held")
    .eq("budget_state", "committed")
    .not("prolific_study_id", "is", null)
    .order("provider_status_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw databaseError("Recruiting studies could not be loaded.", error);
  const results = await Promise.allSettled(
    (data ?? []).map((row) => syncRecruitmentStatus(String(row.id))),
  );
  return results.filter((result) => result.status === "fulfilled").length;
}

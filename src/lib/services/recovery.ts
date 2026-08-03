import { AppError } from "@/lib/errors";
import { databaseError, getInternalStudy } from "@/lib/data";
import { getEnv } from "@/lib/env";
import {
  classifyProlificStudyStatus,
  createProlificClient,
  type ProlificStudy,
} from "@/lib/providers/prolific";
import { ProviderError } from "@/lib/providers/http";
import {
  asRecord,
  claimProviderOperation,
  evidenceRequestId,
  markProviderDispatched,
  recordProviderResult,
  requestFingerprint,
  safeError,
} from "@/lib/services/provider-events";
import { ensureEventControlConfigured } from "@/lib/services/control";
import { getServiceSupabase } from "@/lib/supabase/server";

type RecoveryClaim = {
  studyId: string;
  claimToken: string;
  prolificStudyId: string | null;
  operationStage: string;
};

export async function reconcileStudy(studyId: string, eventSessionId: string): Promise<string> {
  await ensureEventControlConfigured();
  const { data, error } = await getServiceSupabase().rpc("claim_study_reconciliation", {
    p_study_id: studyId,
    p_event_session_id: eventSessionId,
  });
  if (error) throw databaseError("Study recovery could not be claimed.", error);
  const row = asRecord(data);
  if (row.applied !== true) return String(row.status ?? "already_reconciling");
  return reconcileClaim({
    studyId: String(row.studyId),
    claimToken: String(row.claimToken),
    prolificStudyId: typeof row.prolificStudyId === "string" ? row.prolificStudyId : null,
    operationStage: String(row.operationStage),
  });
}

export async function reconcileStaleLaunches(limit = getEnv().RECOVERY_BATCH_SIZE): Promise<number> {
  await ensureEventControlConfigured();
  const { data, error } = await getServiceSupabase().rpc("claim_stale_provider_operations", {
    p_limit: limit,
  });
  if (error) throw databaseError("Stale launch recovery could not start.", error);
  const claims = Array.isArray(data) ? data.map(asRecord) : [];
  const results = await Promise.allSettled(
    claims.map((row) =>
      reconcileClaim({
        studyId: String(row.studyId),
        claimToken: String(row.claimToken),
        prolificStudyId: typeof row.prolificStudyId === "string" ? row.prolificStudyId : null,
        operationStage: String(row.operationStage),
      }),
    ),
  );
  return results.filter((result) => result.status === "fulfilled").length;
}

async function reconcileClaim(claim: RecoveryClaim): Promise<string> {
  const client = createProlificClient();
  const fingerprint = requestFingerprint({
    studyId: claim.studyId,
    externalId: claim.prolificStudyId,
    operationStage: claim.operationStage,
    claimToken: claim.claimToken,
  });
  const operation = await claimProviderOperation({
    provider: "prolific",
    operation: "reconcile_study",
    localOperationKey: `reconcile:${claim.studyId}:${claim.claimToken}`,
    studyId: claim.studyId,
    requestFingerprint: fingerprint,
    sanitizedRequest: { operationStage: claim.operationStage, hasExternalId: Boolean(claim.prolificStudyId) },
  });
  await markProviderDispatched(operation.eventId);

  try {
    const result = claim.prolificStudyId
      ? await client.getStudy(claim.prolificStudyId).then((fetched) => ({
          kind: "found" as const,
          study: fetched.data,
          evidence: [fetched.evidence],
        }))
      : await client.reconcileStudyByIdentity(claim.studyId);
    if (result.kind === "absent") {
      await recordProviderResult({
        eventId: operation.eventId,
        status: "definitive_failure",
        effect: "definitive_no_create",
        response: { matchCount: 0 },
        errorCode: "NO_MATCH",
        errorMessage: "Reconciliation found no external study.",
      });
    } else {
      await recordFoundStudy(operation.eventId, result.study, result.evidence);
    }
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    if (claim.operationStage === "deleting" && error instanceof ProviderError && error.httpStatus === 404) {
      await recordProviderResult({
        eventId: operation.eventId,
        status: "succeeded",
        effect: "external_deleted",
        response: { absent: true, reconciledAfter: "delete" },
        externalResourceId: claim.prolificStudyId ?? undefined,
        errorCode: "CONFIRMED_ABSENT_AFTER_DELETE",
        errorMessage: "Prolific confirmed the deleted draft is absent.",
      });
    } else {
      await recordProviderResult({
        eventId: operation.eventId,
        status: "ambiguous",
        effect: "unknown",
        errorCode: appError?.code ?? "RECONCILIATION_FAILED",
        errorMessage: safeError(appError?.message ?? "Reconciliation failed."),
      });
    }
  }

  const { data: applied, error: applyError } = await getServiceSupabase().rpc(
    "apply_launch_reconciliation",
    {
      p_study_id: claim.studyId,
      p_claim_token: claim.claimToken,
      p_provider_event_id: operation.eventId,
    },
  );
  if (applyError) throw databaseError("Reconciliation result could not be applied.", applyError);
  const outcome = String(applied);
  if (outcome !== "draft_adopted") return outcome;
  return resolveRecoveredDraft(claim.studyId, operation.eventId, client);
}

async function resolveRecoveredDraft(
  studyId: string,
  reconciliationEventId: string,
  client: ReturnType<typeof createProlificClient>,
): Promise<string> {
  const study = await getInternalStudy(studyId);
  const prolificStudyId = String(study.prolific_study_id);
  const fingerprint = requestFingerprint({ studyId: prolificStudyId, action: "PUBLISH" });
  const { data, error } = await getServiceSupabase().rpc("claim_recovery_draft_action", {
    p_study_id: studyId,
    p_reconciliation_event_id: reconciliationEventId,
    p_request_fingerprint: fingerprint,
    p_sanitized_request: { action: "PUBLISH_OR_DELETE_AFTER_RECONCILIATION" },
  });
  if (error) throw databaseError("Recovered draft action could not be claimed.", error);
  const claim = asRecord(data);
  const action = String(claim.action);
  if (claim.applied !== true) return `${action}_already_claimed`;
  const eventId = String(claim.eventId);
  return action === "publish"
    ? publishRecoveredDraft(studyId, prolificStudyId, eventId, client)
    : deleteRecoveredDraft(studyId, prolificStudyId, eventId, client);
}

async function publishRecoveredDraft(
  studyId: string,
  prolificStudyId: string,
  eventId: string,
  client: ReturnType<typeof createProlificClient>,
): Promise<string> {
  let dispatched = false;
  let resultRecorded = false;
  try {
    await markProviderDispatched(eventId);
    dispatched = true;
    const result = await client.publishStudy(prolificStudyId);
    const disposition = classifyProlificStudyStatus(result.data.status);
    if (disposition === "unpublished_draft") {
      await recordProviderResult({
        eventId,
        status: "definitive_failure",
        effect: "draft_exists",
        response: result.data,
        requestId: evidenceRequestId(result.evidence),
        externalResourceId: prolificStudyId,
        externalStatus: "UNPUBLISHED",
        errorCode: "PUBLISH_NOT_APPLIED",
        errorMessage: "Prolific kept the recovered study unpublished.",
      });
      resultRecorded = true;
      return "publish_not_applied";
    }
    if (disposition === "blocked_unknown") {
      throw new AppError("PROVIDER_AMBIGUOUS", "Prolific returned an unresolved publish status.", {
        status: 503,
        retryable: true,
      });
    }
    const effect = disposition === "paid_or_publishing" ? "published_or_spend_possible" : "non_recruiting";
    await recordProviderResult({
      eventId,
      status: "succeeded",
      effect,
      response: result.data,
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: prolificStudyId,
      externalStatus: result.data.status,
    });
    resultRecorded = true;
    const { error: commitError } = await getServiceSupabase().rpc("commit_study_budget", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
    });
    if (commitError) throw databaseError("Recovered study budget could not be committed.", commitError);
    if (effect === "non_recruiting") {
      const { error: releaseError } = await getServiceSupabase().rpc("release_study_slot", {
        p_study_id: studyId,
        p_provider_event_id: eventId,
        p_reason: "provider_non_recruiting",
      });
      if (releaseError) throw databaseError("Recovered recruiting slot could not be released.", releaseError);
    }
    return effect === "non_recruiting" ? "published_non_recruiting" : "published";
  } catch (error) {
    if (resultRecorded) throw error;
    await persistRecoveredMutationFailure({
      studyId,
      eventId,
      stage: "publish",
      error,
      dispatched,
    });
    return "publish_recovery_deferred";
  }
}

async function deleteRecoveredDraft(
  studyId: string,
  prolificStudyId: string,
  eventId: string,
  client: ReturnType<typeof createProlificClient>,
): Promise<string> {
  let dispatched = false;
  let resultRecorded = false;
  try {
    await markProviderDispatched(eventId);
    dispatched = true;
    const result = await client.deleteUnpublishedStudy(prolificStudyId);
    await recordProviderResult({
      eventId,
      status: "succeeded",
      effect: "external_deleted",
      response: { deleted: true },
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: prolificStudyId,
      externalStatus: "UNPUBLISHED",
    });
    resultRecorded = true;
    const { error: abandonError } = await getServiceSupabase().rpc("abandon_unlaunched_study", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
      p_failure_stage: "publish_recovery",
      p_error_code: "PUBLISH_RETRIES_EXHAUSTED",
      p_error_message: "Recovered draft was deleted after two publish attempts.",
    });
    if (abandonError) throw databaseError("Recovered draft could not be safely abandoned.", abandonError);
    return "draft_deleted";
  } catch (error) {
    if (resultRecorded) throw error;
    const appError = error instanceof AppError ? error : null;
    await recordProviderResult({
      eventId,
      status: dispatched ? "ambiguous" : "definitive_failure",
      effect: dispatched ? "unknown" : "request_not_dispatched",
      errorCode: appError?.code ?? "DRAFT_DELETE_FAILED",
      errorMessage: safeError(appError?.message ?? "Recovered draft deletion failed."),
    });
    if (dispatched) await markRecoveredLaunchAmbiguous(studyId, eventId, "delete", appError);
    return "delete_recovery_deferred";
  }
}

async function persistRecoveredMutationFailure(options: {
  studyId: string;
  eventId: string;
  stage: string;
  error: unknown;
  dispatched: boolean;
}): Promise<void> {
  const appError = options.error instanceof AppError ? options.error : null;
  const ambiguous = options.dispatched && appError?.code === "PROVIDER_AMBIGUOUS";
  await recordProviderResult({
    eventId: options.eventId,
    status: ambiguous ? "ambiguous" : "definitive_failure",
    effect: ambiguous ? "unknown" : options.dispatched ? "draft_exists" : "request_not_dispatched",
    errorCode: appError?.code ?? "RECOVERED_MUTATION_FAILED",
    errorMessage: safeError(appError?.message ?? "Recovered provider mutation failed."),
  });
  if (ambiguous) await markRecoveredLaunchAmbiguous(options.studyId, options.eventId, options.stage, appError);
}

async function markRecoveredLaunchAmbiguous(
  studyId: string,
  eventId: string,
  stage: string,
  error: AppError | null,
): Promise<void> {
  const { error: markError } = await getServiceSupabase().rpc("mark_launch_ambiguous", {
    p_study_id: studyId,
    p_provider_event_id: eventId,
    p_failure_stage: stage,
    p_error_code: error?.code ?? "PROVIDER_AMBIGUOUS",
    p_error_message: safeError(error?.message ?? "Provider result requires reconciliation."),
  });
  if (markError) throw databaseError("Ambiguous recovery evidence could not be saved.", markError);
}

async function recordFoundStudy(
  eventId: string,
  study: ProlificStudy,
  evidence: Parameters<typeof evidenceRequestId>[0],
) {
  const disposition = classifyProlificStudyStatus(study.status);
  if (disposition === "blocked_unknown") {
    await recordProviderResult({
      eventId,
      status: "ambiguous",
      effect: "unknown",
      response: { providerStatus: study.status },
      errorCode: "UNKNOWN_PROVIDER_STATUS",
      errorMessage: "Provider status requires reconciliation.",
    });
    return;
  }
  const effect =
    disposition === "unpublished_draft"
      ? "draft_exists"
      : disposition === "paid_or_publishing"
        ? "published_or_spend_possible"
        : "non_recruiting";
  await recordProviderResult({
    eventId,
    status: "succeeded",
    effect,
    response: {
      id: study.id,
      status: study.status,
      internal_name: study.internal_name,
      metadata: study.metadata,
      is_ready_to_publish: study.is_ready_to_publish,
    },
    requestId: evidenceRequestId(evidence),
    externalResourceId: study.id,
    externalStatus: study.status,
  });
}

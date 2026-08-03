import { AppError } from "@/lib/errors";
import { databaseError, getInternalStudy } from "@/lib/data";
import { maximumAllowedTimeMinutes } from "@/lib/domain/money";
import { classifyProlificStudyStatus, createProlificClient } from "@/lib/providers/prolific";
import {
  asRecord,
  evidenceRequestId,
  markProviderDispatched,
  recordProviderResult,
  requestFingerprint,
  safeError,
} from "@/lib/services/provider-events";
import { getServiceSupabase } from "@/lib/supabase/server";

export async function finishStudy(studyId: string, eventSessionId: string): Promise<void> {
  const study = await getInternalStudy(studyId);
  if (study.manual_finish_at && study.report_snapshot_at) return;
  const prolificStudyId = String(study.prolific_study_id ?? "");
  const fingerprint = requestFingerprint({ prolificStudyId, action: "PAUSE" });
  const { data, error } = await getServiceSupabase().rpc("claim_manual_pause", {
    p_study_id: studyId,
    p_event_session_id: eventSessionId,
    p_request_fingerprint: fingerprint,
    p_sanitized_request: { action: "PAUSE" },
  });
  if (error) throw databaseError("Manual finish is not available yet.", error);
  const claim = asRecord(data);
  if (claim.applied !== true) {
    throw new AppError("CONFLICT", "A finish request is already in progress.", {
      status: 409,
      retryable: true,
    });
  }
  const eventId = String(claim.eventId);
  let resultRecorded = false;
  let dispatched = false;
  try {
    await markProviderDispatched(eventId);
    dispatched = true;
    const result = await createProlificClient().pauseStudy(prolificStudyId);
    if (result.data.status !== "PAUSED") {
      throw new AppError("PROVIDER_AMBIGUOUS", "Prolific has not confirmed that recruitment paused.", {
        status: 503,
        retryable: true,
      });
    }
    await recordProviderResult({
      eventId,
      status: "succeeded",
      effect: "non_recruiting",
      response: result.data,
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: prolificStudyId,
      externalStatus: "PAUSED",
    });
    resultRecorded = true;
    const { error: confirmError } = await getServiceSupabase().rpc("confirm_manual_pause", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
      p_pause_cutoff_at: new Date().toISOString(),
    });
    if (confirmError) throw databaseError("Confirmed pause could not be saved.", confirmError);
  } catch (error) {
    if (!resultRecorded) {
      const appError = error instanceof AppError ? error : null;
      const ambiguous = dispatched && appError?.code === "PROVIDER_AMBIGUOUS";
      await recordProviderResult({
        eventId,
        status: ambiguous ? "ambiguous" : "definitive_failure",
        effect: ambiguous ? "unknown" : dispatched ? "unknown" : "request_not_dispatched",
        errorCode: appError?.code ?? "PAUSE_FAILED",
        errorMessage: safeError(appError?.message ?? "Manual pause failed."),
      });
      if (ambiguous) {
        const result = await getServiceSupabase().rpc("mark_launch_ambiguous", {
          p_study_id: studyId,
          p_provider_event_id: eventId,
          p_failure_stage: "pause",
          p_error_code: appError?.code ?? "PROVIDER_AMBIGUOUS",
          p_error_message: safeError(appError?.message ?? "Manual pause is unresolved."),
        });
        if (result.error) throw databaseError("Ambiguous pause evidence could not be saved.", result.error);
      }
    }
    throw error;
  }
}

export async function stopFinishedStudies(limit: number): Promise<number> {
  const { data, error } = await getServiceSupabase()
    .from("studies")
    .select("id,prolific_study_id,pause_cutoff_at,estimated_minutes,manual_finish_at,final_stop_requested_at")
    .not("manual_finish_at", "is", null)
    .eq("prolific_status", "PAUSED")
    .is("final_stop_confirmed_at", null)
    .order("manual_finish_at", { ascending: true })
    .limit(limit);
  if (error) throw databaseError("Finished studies could not be checked.", error);
  const results = await Promise.allSettled(
    (data ?? []).map(async (row) => {
      const client = createProlificClient();
      const outstanding = await client.listOutstandingSubmissions(
        String(row.prolific_study_id),
        String(row.pause_cutoff_at),
      );
      const maximumMinutes = maximumAllowedTimeMinutes(Number(row.estimated_minutes));
      const allExpired = outstanding.data.every(
        (submission) => Date.parse(submission.started_at) + maximumMinutes * 60_000 <= Date.now(),
      );
      if (outstanding.data.length > 0 && !allExpired) return false;
      await stopOne(String(row.id), String(row.prolific_study_id));
      return true;
    }),
  );
  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}

async function stopOne(studyId: string, prolificStudyId: string) {
  const fingerprint = requestFingerprint({ prolificStudyId, action: "STOP" });
  const { data, error } = await getServiceSupabase().rpc("claim_final_stop", {
    p_study_id: studyId,
    p_request_fingerprint: fingerprint,
    p_sanitized_request: { action: "STOP" },
  });
  if (error) throw databaseError("Final stop could not be claimed.", error);
  const claim = asRecord(data);
  if (claim.applied !== true) return;
  const eventId = String(claim.eventId);
  let resultRecorded = false;
  let dispatched = false;
  try {
    await markProviderDispatched(eventId);
    dispatched = true;
    const result = await createProlificClient().stopStudy(prolificStudyId);
    const disposition = classifyProlificStudyStatus(result.data.status);
    if (disposition !== "paid_non_recruiting" || result.data.status === "PAUSED") {
      throw new AppError("PROVIDER_AMBIGUOUS", "Prolific has not confirmed the final stop.", {
        status: 503,
        retryable: true,
      });
    }
    await recordProviderResult({
      eventId,
      status: "succeeded",
      effect: "non_recruiting",
      response: result.data,
      requestId: evidenceRequestId(result.evidence),
      externalResourceId: prolificStudyId,
      externalStatus: result.data.status,
    });
    resultRecorded = true;
    const { error: confirmError } = await getServiceSupabase().rpc("confirm_final_stop", {
      p_study_id: studyId,
      p_provider_event_id: eventId,
    });
    if (confirmError) throw databaseError("Final stop confirmation could not be saved.", confirmError);
  } catch (error) {
    if (!resultRecorded) {
      const appError = error instanceof AppError ? error : null;
      const ambiguous = dispatched && appError?.code === "PROVIDER_AMBIGUOUS";
      await recordProviderResult({
        eventId,
        status: ambiguous ? "ambiguous" : "definitive_failure",
        effect: ambiguous ? "unknown" : dispatched ? "unknown" : "request_not_dispatched",
        errorCode: appError?.code ?? "STOP_FAILED",
        errorMessage: safeError(appError?.message ?? "Final stop failed."),
      });
    }
    throw error;
  }
}

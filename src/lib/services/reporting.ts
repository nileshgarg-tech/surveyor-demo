import { AppError } from "@/lib/errors";
import { databaseError, getCompletedAnswers, getInternalStudy } from "@/lib/data";
import { getEnv } from "@/lib/env";
import { surveySpecSchema } from "@/lib/domain/schemas";
import { generateReportNarrative } from "@/lib/services/ai";
import { ensureEventControlConfigured } from "@/lib/services/control";
import { asRecord, safeError } from "@/lib/services/provider-events";
import { getServiceSupabase } from "@/lib/supabase/server";

type ReportClaim = {
  studyId: string;
  claimToken: string;
  sampleSize: number;
  snapshotCutoffAt: string;
  completionReason: "target" | "manual";
};

export async function maybeStartReport(studyId: string): Promise<boolean> {
  await ensureEventControlConfigured();
  try {
    await getServiceSupabase().rpc("recover_stale_reports", { p_limit: 10 });
  } catch {}
  const study = await getInternalStudy(studyId);
  if (!study.event_session_id || study.status !== "ready_to_report") return false;
  const { data, error } = await getServiceSupabase().rpc("claim_report", {
    p_study_id: studyId,
    p_event_session_id: String(study.event_session_id),
  });
  if (error) throw databaseError("Report could not be claimed.", error);
  const row = asRecord(data);
  if (row.applied !== true) return false;
  await generateClaimedReport(parseClaim(row));
  return true;
}

export async function retryBlockedReport(studyId: string, eventSessionId: string): Promise<void> {
  await ensureEventControlConfigured();
  const { data: recovered, error: recoveryError } = await getServiceSupabase().rpc(
    "recover_ended_manual_finish",
    { p_study_id: studyId, p_event_session_id: eventSessionId },
  );
  if (recoveryError) throw databaseError("Ended manual finish could not be recovered.", recoveryError);
  if (recovered === true) {
    await maybeStartReport(studyId);
    return;
  }
  const { error } = await getServiceSupabase().rpc("retry_blocked_report", {
    p_study_id: studyId,
    p_event_session_id: eventSessionId,
  });
  if (error) throw databaseError("Blocked report could not be retried.", error);
  await maybeStartReport(studyId);
}

export async function recoverEndedManualFinishes(limit = getEnv().RECOVERY_BATCH_SIZE): Promise<number> {
  await ensureEventControlConfigured();
  const { data, error } = await getServiceSupabase().rpc("recover_ended_manual_finishes", {
    p_limit: limit,
  });
  if (error) throw databaseError("Ended manual finishes could not be recovered.", error);
  return Number(data ?? 0);
}

export async function recoverAndRunReports(limit = getEnv().RECOVERY_BATCH_SIZE): Promise<{
  recovered: number;
  started: number;
}> {
  await ensureEventControlConfigured();
  const { data: recoveredData, error: recoverError } = await getServiceSupabase().rpc(
    "recover_stale_reports",
    { p_limit: limit },
  );
  if (recoverError) throw databaseError("Stale reports could not be recovered.", recoverError);
  const recovered = Array.isArray(recoveredData) ? recoveredData.length : 0;
  const { data: claimsData, error: claimsError } = await getServiceSupabase().rpc(
    "claim_ready_reports",
    { p_limit: limit },
  );
  if (claimsError) throw databaseError("Ready reports could not be claimed.", claimsError);
  const rows = Array.isArray(claimsData) ? claimsData.map(asRecord) : [];
  const results = await Promise.allSettled(
    rows.map((row) => generateClaimedReport(parseClaim(row))),
  );
  const started = results.filter((result) => result.status === "fulfilled").length;
  return { recovered, started };
}

async function generateClaimedReport(claim: ReportClaim): Promise<void> {
  try {
    await heartbeat(claim);
    const study = await getInternalStudy(claim.studyId);
    const survey = surveySpecSchema.parse(study.survey_spec);
    const responses = await getCompletedAnswers(claim.studyId, claim.snapshotCutoffAt);
    if (responses.length !== claim.sampleSize) {
      throw new AppError("SCHEMA_DRIFT", "The frozen report sample no longer matches stored responses.", {
        status: 500,
      });
    }
    const shortRefs = new Set(
      survey.questions.filter((question) => question.type === "short_text").map((question) => question.ref),
    );
    const anonymousTextAnswers = responses.flatMap((answers) =>
      [...shortRefs]
        .map((ref) => answers[ref])
        .filter((value): value is string => typeof value === "string"),
    );
    const generated = await generateReportNarrative({
      survey,
      responses,
      anonymousTextAnswers,
      completionReason: claim.completionReason,
    });
    await heartbeat(claim);
    const { error: completeError } = await getServiceSupabase().rpc("complete_report", {
      p_study_id: claim.studyId,
      p_claim_token: claim.claimToken,
      p_deterministic_aggregates: generated.aggregates,
      p_narrative: generated.narrative,
      p_ai_provider: generated.provider,
      p_ai_model: generated.model,
      p_sanitized_provider_metadata: { generatedAt: new Date().toISOString() },
    });
    if (completeError) throw databaseError("Completed report could not be saved.", completeError);
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    const { error: failureError } = await getServiceSupabase().rpc("fail_report_attempt", {
      p_study_id: claim.studyId,
      p_claim_token: claim.claimToken,
      p_error_code: appError?.code ?? "REPORT_GENERATION_FAILED",
      p_error_message: safeError(appError?.message ?? "Report generation failed."),
      p_retryable: appError?.retryable ?? true,
    });
    if (failureError) throw databaseError("Report failure state could not be saved.", failureError);
    throw error;
  }
}

async function heartbeat(claim: ReportClaim): Promise<void> {
  const { data, error } = await getServiceSupabase().rpc("heartbeat_report", {
    p_study_id: claim.studyId,
    p_claim_token: claim.claimToken,
  });
  if (error) throw databaseError("Report heartbeat could not be saved.", error);
  if (data !== true) throw new AppError("CONFLICT", "This report worker claim is stale.", { status: 409 });
}

function parseClaim(row: Record<string, unknown>): ReportClaim {
  const reason = row.completionReason;
  if (reason !== "target" && reason !== "manual") {
    throw new AppError("SCHEMA_DRIFT", "Report claim has an invalid completion reason.", { status: 500 });
  }
  return {
    studyId: String(row.studyId),
    claimToken: String(row.claimToken),
    sampleSize: Number(row.sampleSize),
    snapshotCutoffAt: String(row.snapshotCutoffAt),
    completionReason: reason,
  };
}

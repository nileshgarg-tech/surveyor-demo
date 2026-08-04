import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import {
  reportNarrativeSchema,
  studyBriefSchema,
  studyStatusSchema,
  surveySpecSchema,
  targetingPlanSchema,
  type ReportNarrative,
  type StudyBrief,
  type StudyStatus,
  type SurveyAnswers,
  type SurveySpec,
  type TargetingPlan,
} from "@/lib/domain/schemas";
import type { DeterministicAggregates } from "@/lib/domain/report";
import { getServiceSupabase } from "@/lib/supabase/server";

export type ParticipantCostOption = {
  participants: 5 | 10 | 20;
  totalCents: number | null;
  enabled: boolean;
  checkedAt: string | null;
  error?: string;
};

export type PublicReport = {
  sampleSize: number;
  snapshotCutoffAt: string;
  completionReason: "target" | "manual";
  aggregates: DeterministicAggregates;
  narrative: ReportNarrative;
};

export type PublicStudy = {
  id: string;
  brief: StudyBrief;
  survey: SurveySpec;
  targeting: TargetingPlan;
  participantCount: 5 | 10 | 20;
  participantCostOptions: ParticipantCostOption[];
  estimatedMinutes: number;
  rewardCents: number;
  roughEstimateCents: number;
  authoritativeTotalCents: number | null;
  currencyCode: string | null;
  costCheckedAt: string | null;
  status: StudyStatus;
  proxyAccepted: boolean;
  responseCount: number;
  createdAt: string;
  launchConfirmedAt: string | null;
  manualFinishAt: string | null;
  failureMessage: string | null;
  operationStage: string;
  staleOperation: boolean;
  report: PublicReport | null;
};

export type PublicStudySummary = {
  id: string;
  title: string;
  targetAudience: string;
  status: StudyStatus;
  participantCount: 5 | 10 | 20;
  createdAt: string;
  launchConfirmedAt: string | null;
};

const safeStudyColumns = [
  "id",
  "brief",
  "survey_spec",
  "targeting_plan",
  "participant_count",
  "participant_cost_options",
  "estimated_minutes",
  "reward_cents",
  "rough_estimate_cents",
  "authoritative_total_cents",
  "currency_code",
  "authoritative_cost_checked_at",
  "status",
  "proxy_accepted_at",
  "created_at",
  "launch_confirmed_at",
  "manual_finish_at",
  "failure_message",
  "operation_stage",
  "operation_heartbeat_at",
].join(",");

export async function getPublicStudy(studyId: string): Promise<PublicStudy> {
  const supabase = getServiceSupabase();
  const [studyResult, responseResult, reportResult] = await Promise.all([
    supabase.from("studies").select(safeStudyColumns).eq("id", studyId).maybeSingle(),
    supabase
      .from("participant_responses")
      .select("id", { count: "exact", head: true })
      .eq("study_id", studyId)
      .eq("status", "completed"),
    supabase
      .from("reports")
      .select(
        "status,sample_size,snapshot_cutoff_at,completion_reason,deterministic_aggregates,narrative",
      )
      .eq("study_id", studyId)
      .maybeSingle(),
  ]);
  if (studyResult.error) throw databaseError("Study could not be loaded.", studyResult.error);
  if (!studyResult.data) throw new AppError("NOT_FOUND", "Study not found.", { status: 404 });
  if (responseResult.error) throw databaseError("Response count could not be loaded.", responseResult.error);
  if (reportResult.error) throw databaseError("Report could not be loaded.", reportResult.error);

  const row = studyResult.data as unknown as Record<string, unknown>;
  const operationHeartbeat = typeof row.operation_heartbeat_at === "string" ? row.operation_heartbeat_at : null;
  const staleMinutes = getEnv().STALE_LAUNCH_MINUTES;
  const staleOperation =
    ["launching", "reconciling"].includes(String(row.status)) &&
    Boolean(operationHeartbeat && Date.parse(operationHeartbeat) < Date.now() - staleMinutes * 60_000);
  return {
    id: String(row.id),
    brief: studyBriefSchema.parse(row.brief),
    survey: surveySpecSchema.parse(row.survey_spec),
    targeting: targetingPlanSchema.parse(row.targeting_plan),
    participantCount: parseParticipantCount(row.participant_count),
    participantCostOptions: parseCostOptions(row.participant_cost_options),
    estimatedMinutes: Number(row.estimated_minutes),
    rewardCents: Number(row.reward_cents),
    roughEstimateCents: Number(row.rough_estimate_cents),
    authoritativeTotalCents:
      row.authoritative_total_cents === null ? null : Number(row.authoritative_total_cents),
    currencyCode: row.currency_code === null ? null : String(row.currency_code),
    costCheckedAt:
      row.authoritative_cost_checked_at === null ? null : String(row.authoritative_cost_checked_at),
    status: studyStatusSchema.parse(row.status),
    proxyAccepted: Boolean(row.proxy_accepted_at),
    responseCount: responseResult.count ?? 0,
    createdAt: String(row.created_at),
    launchConfirmedAt: row.launch_confirmed_at === null ? null : String(row.launch_confirmed_at),
    manualFinishAt: row.manual_finish_at === null ? null : String(row.manual_finish_at),
    failureMessage: row.failure_message === null ? null : String(row.failure_message),
    operationStage: String(row.operation_stage),
    staleOperation,
    report: parsePublicReport(reportResult.data as Record<string, unknown> | null),
  };
}

export async function getPublicStudiesList(): Promise<PublicStudySummary[]> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("studies")
    .select("id,brief,status,participant_count,created_at,launch_confirmed_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw databaseError("Studies list could not be loaded.", error);
  return (data ?? []).map((row) => {
    const brief = studyBriefSchema.parse(row.brief);
    return {
      id: String(row.id),
      title: brief.title,
      targetAudience: brief.targetAudience,
      status: studyStatusSchema.parse(row.status),
      participantCount: parseParticipantCount(row.participant_count),
      createdAt: String(row.created_at),
      launchConfirmedAt: row.launch_confirmed_at === null ? null : String(row.launch_confirmed_at),
    };
  });
}

export async function getInternalStudy(studyId: string): Promise<Record<string, unknown>> {
  const { data, error } = await getServiceSupabase()
    .from("studies")
    .select("*")
    .eq("id", studyId)
    .maybeSingle();
  if (error) throw databaseError("Study could not be loaded.", error);
  if (!data) throw new AppError("NOT_FOUND", "Study not found.", { status: 404 });
  return data as Record<string, unknown>;
}

export async function getSafeIndividualResponses(studyId: string): Promise<
  Array<{
    participantNumber: number;
    submittedAt: string;
    answers: SurveyAnswers;
  }>
> {
  const { data, error } = await getServiceSupabase()
    .from("participant_responses")
    .select("answers,submitted_at")
    .eq("study_id", studyId)
    .eq("status", "completed")
    .order("submitted_at", { ascending: true });
  if (error) throw databaseError("Responses could not be loaded.", error);
  return (data ?? []).map((row, index) => ({
    participantNumber: index + 1,
    submittedAt: String(row.submitted_at),
    answers: row.answers as SurveyAnswers,
  }));
}

export async function getCompletedAnswers(
  studyId: string,
  snapshotCutoffAt: string,
): Promise<SurveyAnswers[]> {
  const { data, error } = await getServiceSupabase()
    .from("participant_responses")
    .select("answers")
    .eq("study_id", studyId)
    .eq("status", "completed")
    .lte("submitted_at", snapshotCutoffAt)
    .order("submitted_at", { ascending: true });
  if (error) throw databaseError("Report responses could not be loaded.", error);
  return (data ?? []).map((row) => row.answers as SurveyAnswers);
}

export function publicStudyResponse(study: PublicStudy, canViewResponses = false) {
  return { ...study, canViewResponses };
}

export function databaseError(message: string, cause: unknown): AppError {
  return new AppError("INTERNAL", message, { status: 503, retryable: true, cause });
}

function parsePublicReport(row: Record<string, unknown> | null): PublicReport | null {
  if (!row || row.status !== "complete") return null;
  return {
    sampleSize: Number(row.sample_size),
    snapshotCutoffAt: String(row.snapshot_cutoff_at),
    completionReason: row.completion_reason === "manual" ? "manual" : "target",
    aggregates: row.deterministic_aggregates as DeterministicAggregates,
    narrative: reportNarrativeSchema.parse(row.narrative),
  };
}

function parseParticipantCount(value: unknown): 5 | 10 | 20 {
  const count = Number(value);
  if (count === 5 || count === 10 || count === 20) return count;
  throw new AppError("SCHEMA_DRIFT", "Stored participant count is invalid.", { status: 500 });
}

function parseCostOptions(value: unknown): ParticipantCostOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const participants = Number(row.participants);
    if (participants !== 5 && participants !== 10 && participants !== 20) return [];
    return [
      {
        participants,
        totalCents: row.totalCents === null ? null : Number(row.totalCents),
        enabled: row.enabled === true,
        checkedAt: row.checkedAt === null ? null : String(row.checkedAt),
        ...(typeof row.error === "string" ? { error: row.error } : {}),
      } as ParticipantCostOption,
    ];
  });
}

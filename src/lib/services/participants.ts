import { createHash } from "node:crypto";
import { z } from "zod";
import { maximumAllowedTimeMinutes } from "@/lib/domain/money";
import { type SurveySpec, surveySpecSchema } from "@/lib/domain/schemas";
import { readableAnswerSummary, validateAnswers } from "@/lib/domain/survey";
import { getEnv, requireLiveConfig, requireSecret } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { createProlificClient, prolificIdSchema } from "@/lib/providers/prolific";
import { participantFingerprint, timingSafeTokenEqual } from "@/lib/security/crypto";
import { getServiceSupabase } from "@/lib/supabase/server";

export const PARTICIPANT_SESSION_TTL_MS = 2 * 60 * 60 * 1_000;
export const COMPLETED_REVISIT_SESSION_TTL_MS = 10 * 60 * 1_000;

export const participantIdentifiersSchema = z
  .object({
    participantId: prolificIdSchema,
    prolificStudyId: prolificIdSchema,
    submissionId: prolificIdSchema,
  })
  .strict();
export type ParticipantIdentifiers = z.infer<typeof participantIdentifiersSchema>;

export type ParticipantPageState = {
  phase: "consent" | "survey" | "declined" | "completed" | "issue";
  survey: SurveySpec;
  retentionText: string;
  contactEmail: string | null;
  completionUrl?: string;
  completionCode?: string;
};

export type ValidatedParticipant = {
  fingerprint: string;
  cookieExpiresAt: Date;
  state: ParticipantPageState;
};

export type SubmittedParticipantResponse = {
  applied: boolean;
  reportBecameReady: boolean;
  completedCount?: number;
  completionUrl: string;
  completionCode: string;
};

const participantResponseStatusSchema = z.enum(["started", "declined", "completed", "issue"]);

const initialStudyRowSchema = z
  .object({
    id: z.uuid(),
    prolific_study_id: prolificIdSchema,
    prolific_completion_code: z.string().trim().min(1).max(64),
    estimated_minutes: z.number().int().min(1).max(5),
    manual_finish_at: z.string().nullable(),
    pause_cutoff_at: z.string().nullable(),
  })
  .strict();

const existingIdentitySchema = z
  .object({
    status: participantResponseStatusSchema,
    prolific_participant_id: prolificIdSchema,
    prolific_study_id: prolificIdSchema,
    participant_session_fingerprint: z.string().regex(/^[a-f\d]{64}$/),
  })
  .strict();

const beginResponseSchema = z
  .object({
    responseId: z.uuid(),
    created: z.boolean(),
    status: participantResponseStatusSchema,
    consented: z.boolean(),
    completed: z.boolean(),
  })
  .strict();

const participantStudyPageSchema = z
  .object({
    survey_spec: z.unknown(),
    prolific_completion_code: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();

const participantSubmitStudySchema = z
  .object({
    survey_spec: z.unknown(),
    prolific_completion_code: z.string().trim().min(1).max(64),
  })
  .strict();

const participantPageRowSchema = z
  .object({
    status: participantResponseStatusSchema,
    consented_at: z.string().nullable(),
  })
  .strict();

const submitResponseSchema = z
  .object({
    applied: z.boolean(),
    responseId: z.uuid(),
    reportBecameReady: z.boolean(),
    completedCount: z.number().int().nonnegative().optional(),
    completionCode: z.string().trim().min(1).max(64),
  })
  .strict();

export async function validateInitialParticipant(
  studyId: string,
  identifiersInput: ParticipantIdentifiers,
): Promise<ValidatedParticipant> {
  const localStudyId = z.uuid().parse(studyId);
  const identifiers = participantIdentifiersSchema.parse(identifiersInput);
  requireLiveConfig(["RESEARCH_CONTACT_EMAIL"]);
  const supabase = getServiceSupabase();

  const [studyResult, existingResult] = await Promise.all([
    supabase
      .from("studies")
      .select(
        "id,prolific_study_id,prolific_completion_code,estimated_minutes,manual_finish_at,pause_cutoff_at",
      )
      .eq("id", localStudyId)
      .maybeSingle(),
    supabase
      .from("participant_responses")
      .select(
        "status,prolific_participant_id,prolific_study_id,participant_session_fingerprint",
      )
      .eq("study_id", localStudyId)
      .eq("prolific_submission_id", identifiers.submissionId)
      .maybeSingle(),
  ]);
  if (studyResult.error) throw participantDatabaseError("Survey could not be validated.", studyResult.error);
  if (!studyResult.data) throw new AppError("NOT_FOUND", "Survey not found.", { status: 404 });
  if (existingResult.error) {
    throw participantDatabaseError("Participant session could not be checked.", existingResult.error);
  }

  const study = parseStrict(initialStudyRowSchema, studyResult.data, "stored participant study");
  if (study.prolific_study_id !== identifiers.prolificStudyId) {
    throw new AppError("FORBIDDEN", "The Prolific study does not match this survey.", { status: 403 });
  }
  if (study.manual_finish_at && !study.pause_cutoff_at) {
    throw new AppError("SCHEMA_DRIFT", "The survey pause cutoff is missing.", { status: 503 });
  }

  const fingerprint = participantFingerprint(
    requireSecret("SESSION_SIGNING_SECRET"),
    identifiers.participantId,
    identifiers.prolificStudyId,
    identifiers.submissionId,
  );
  const existing = existingResult.data
    ? parseStrict(existingIdentitySchema, existingResult.data, "stored participant identity")
    : null;
  if (
    existing &&
    (existing.prolific_participant_id !== identifiers.participantId ||
      existing.prolific_study_id !== identifiers.prolificStudyId ||
      !timingSafeTokenEqual(existing.participant_session_fingerprint, fingerprint))
  ) {
    throw new AppError("FORBIDDEN", "The participant session identity does not match.", {
      status: 403,
    });
  }

  const providerValidation = await createProlificClient().validateSubmission({
    submissionId: identifiers.submissionId,
    studyId: identifiers.prolificStudyId,
    participantId: identifiers.participantId,
    localResponseCompleted: existing?.status === "completed",
    ...(study.manual_finish_at && study.pause_cutoff_at
      ? { pauseCutoff: study.pause_cutoff_at }
      : {}),
  });
  const providerSubmission = providerValidation.data.submission;

  if (existing?.status === "completed") {
    if (
      providerValidation.data.kind !== "completed_revisit" ||
      (providerSubmission.status !== "AWAITING REVIEW" && providerSubmission.status !== "APPROVED")
    ) {
      throw new AppError(
        "CONFLICT",
        "This completed response is not currently available for revisit.",
        { status: 409 },
      );
    }
  } else if (providerValidation.data.kind !== "collect") {
    throw new AppError(
      "CONFLICT",
      "This Prolific submission cannot currently collect a response. Please return to Prolific for guidance.",
      { status: 409 },
    );
  }

  const now = Date.now();
  const providerWindowEndsAt =
    Date.parse(providerSubmission.started_at) +
    maximumAllowedTimeMinutes(study.estimated_minutes) * 60 * 1_000;
  const cookieExpiresAt =
    existing?.status === "completed"
      ? new Date(now + COMPLETED_REVISIT_SESSION_TTL_MS)
      : new Date(Math.min(now + PARTICIPANT_SESSION_TTL_MS, providerWindowEndsAt));
  if (cookieExpiresAt.getTime() <= now) {
    throw new AppError(
      "CONFLICT",
      "The Prolific participation window has ended. Please return to Prolific for guidance.",
      { status: 409 },
    );
  }

  const { data: begunData, error: begunError } = await supabase.rpc("begin_participant_response", {
    p_study_id: localStudyId,
    p_prolific_participant_id: identifiers.participantId,
    p_prolific_submission_id: identifiers.submissionId,
    p_prolific_study_id: identifiers.prolificStudyId,
    p_provider_started_at: providerSubmission.started_at,
    p_provider_status: providerSubmission.status,
    p_participant_session_fingerprint: fingerprint,
  });
  if (begunError) throw participantRpcError(begunError);
  parseStrict(beginResponseSchema, begunData, "participant response start");

  return {
    fingerprint,
    cookieExpiresAt,
    state: await getParticipantPageState(localStudyId, fingerprint),
  };
}

export async function getParticipantPageState(
  studyId: string,
  participantSessionFingerprint: string,
): Promise<ParticipantPageState> {
  const localStudyId = z.uuid().parse(studyId);
  const fingerprint = z.string().regex(/^[a-f\d]{64}$/).parse(participantSessionFingerprint);
  const supabase = getServiceSupabase();
  const [studyResult, responseResult] = await Promise.all([
    supabase
      .from("studies")
      .select("survey_spec,prolific_completion_code")
      .eq("id", localStudyId)
      .maybeSingle(),
    supabase
      .from("participant_responses")
      .select("status,consented_at")
      .eq("study_id", localStudyId)
      .eq("participant_session_fingerprint", fingerprint)
      .maybeSingle(),
  ]);
  if (studyResult.error) throw participantDatabaseError("Survey could not be loaded.", studyResult.error);
  if (!studyResult.data) throw new AppError("NOT_FOUND", "Survey not found.", { status: 404 });
  if (responseResult.error) {
    throw participantDatabaseError("Participant session could not be loaded.", responseResult.error);
  }
  if (!responseResult.data) {
    throw new AppError("FORBIDDEN", "A validated Prolific session is required.", { status: 401 });
  }

  const study = parseStrict(participantStudyPageSchema, studyResult.data, "participant survey");
  const participant = parseStrict(
    participantPageRowSchema,
    responseResult.data,
    "participant response",
  );
  const survey = surveySpecSchema.parse(study.survey_spec);
  const env = getEnv();
  if (participant.status === "started" && !env.RESEARCH_CONTACT_EMAIL) {
    throw new AppError("SETUP_REQUIRED", "Research contact information is not configured.", {
      status: 503,
    });
  }
  const common = {
    survey,
    retentionText: env.RESPONSE_RETENTION_TEXT,
    contactEmail: env.RESEARCH_CONTACT_EMAIL ?? null,
  };

  switch (participant.status) {
    case "completed": {
      if (!study.prolific_completion_code) {
        throw new AppError("SCHEMA_DRIFT", "The Prolific completion code is missing.", {
          status: 503,
        });
      }
      return {
        phase: "completed",
        ...common,
        completionCode: study.prolific_completion_code,
        completionUrl: completionUrl(study.prolific_completion_code),
      };
    }
    case "declined":
      return { phase: "declined", ...common };
    case "issue":
      return { phase: "issue", ...common };
    case "started":
      return { phase: participant.consented_at ? "survey" : "consent", ...common };
  }
}

export async function recordParticipantConsent(
  studyId: string,
  participantSessionFingerprint: string,
  agreed: boolean,
): Promise<ParticipantPageState> {
  const localStudyId = z.uuid().parse(studyId);
  const fingerprint = z.string().regex(/^[a-f\d]{64}$/).parse(participantSessionFingerprint);
  const { error } = await getServiceSupabase().rpc("record_participant_consent", {
    p_study_id: localStudyId,
    p_participant_session_fingerprint: fingerprint,
    p_agreed: z.boolean().parse(agreed),
  });
  if (error) throw participantRpcError(error);
  return getParticipantPageState(localStudyId, fingerprint);
}

export async function submitParticipantResponse(
  studyId: string,
  participantSessionFingerprint: string,
  answersInput: unknown,
): Promise<SubmittedParticipantResponse> {
  const localStudyId = z.uuid().parse(studyId);
  const fingerprint = z.string().regex(/^[a-f\d]{64}$/).parse(participantSessionFingerprint);
  const { data: studyData, error: studyError } = await getServiceSupabase()
    .from("studies")
    .select("survey_spec,prolific_completion_code")
    .eq("id", localStudyId)
    .maybeSingle();
  if (studyError) throw participantDatabaseError("Survey could not be loaded.", studyError);
  if (!studyData) throw new AppError("NOT_FOUND", "Survey not found.", { status: 404 });

  const study = parseStrict(participantSubmitStudySchema, studyData, "participant submission study");
  const survey = surveySpecSchema.parse(study.survey_spec);
  const answers = validateAnswers(survey, answersInput);
  const answerFingerprint = createHash("sha256").update(JSON.stringify(answers)).digest("hex");
  const readableSummary = readableAnswerSummary(survey, answers).split("\n");
  const { data, error } = await getServiceSupabase().rpc("submit_participant_response", {
    p_study_id: localStudyId,
    p_participant_session_fingerprint: fingerprint,
    p_answer_fingerprint: answerFingerprint,
    p_answers: answers,
    p_readable_summary: readableSummary,
  });
  if (error) throw participantRpcError(error);
  const submitted = parseStrict(submitResponseSchema, data, "participant submission");
  return {
    applied: submitted.applied,
    reportBecameReady: submitted.reportBecameReady,
    ...(submitted.completedCount === undefined
      ? {}
      : { completedCount: submitted.completedCount }),
    completionCode: submitted.completionCode,
    completionUrl: completionUrl(submitted.completionCode),
  };
}

function completionUrl(code: string): string {
  return `https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(code)}`;
}

function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("SCHEMA_DRIFT", `The ${label} contract is invalid.`, {
      status: 503,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function participantRpcError(error: unknown): AppError {
  const text = rpcErrorText(error);
  if (text.includes("DIFFERING_DUPLICATE_SUBMISSION")) {
    return new AppError("CONFLICT", "This response was already submitted with different answers.", {
      status: 409,
      cause: error,
    });
  }
  if (text.includes("CONSENT_REQUIRED") || text.includes("CONSENT_DECLINE_IS_FINAL")) {
    return new AppError("CONFLICT", "Consent is required before submitting this survey.", {
      status: 409,
      cause: error,
    });
  }
  if (
    text.includes("PARTICIPANT_SESSION_NOT_FOUND") ||
    text.includes("PARTICIPANT_IDENTITY_MISMATCH") ||
    text.includes("PROLIFIC_STUDY_MISMATCH")
  ) {
    return new AppError("FORBIDDEN", "The validated participant session does not match.", {
      status: 403,
      cause: error,
    });
  }
  if (
    text.includes("PARTICIPANT_STARTED_AFTER_PAUSE") ||
    text.includes("PROVIDER_SUBMISSION_NOT_COLLECTABLE") ||
    text.includes("COMPLETED_REVISIT_STATUS_INVALID") ||
    text.includes("STUDY_NOT_COLLECTING") ||
    text.includes("STUDY_NOT_ACCEPTING_RESPONSES") ||
    text.includes("PARTICIPANT_NOT_STARTABLE")
  ) {
    return new AppError(
      "CONFLICT",
      "This survey can no longer accept this submission. Please return to Prolific for guidance.",
      { status: 409, cause: error },
    );
  }
  if (text.includes("STUDY_NOT_FOUND")) {
    return new AppError("NOT_FOUND", "Survey not found.", { status: 404, cause: error });
  }
  return participantDatabaseError("The participant response could not be saved.", error);
}

function rpcErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const row = error as Record<string, unknown>;
  return [row.code, row.message, row.details, row.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function participantDatabaseError(message: string, cause: unknown): AppError {
  return new AppError("INTERNAL", message, {
    status: 503,
    retryable: true,
    cause,
  });
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const LOCAL_STUDY_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_LOCAL_STUDY_ID = "223e4567-e89b-12d3-a456-426614174000";
const PROLIFIC_STUDY_ID = "a".repeat(24);
const PARTICIPANT_ID = "b".repeat(24);
const SUBMISSION_ID = "c".repeat(24);
const SESSION_SECRET = "participant-test-secret-".padEnd(64, "x");
const FINGERPRINT = "f".repeat(64);

const mocks = vi.hoisted(() => ({
  tableQueues: new Map<string, Array<{ data: unknown; error: unknown }>>(),
  rpcQueues: new Map<string, Array<{ data: unknown; error: unknown }>>(),
  from: vi.fn(),
  rpc: vi.fn(),
  validateSubmission: vi.fn(),
  env: {
    NEXT_PUBLIC_APP_URL: "https://surveyor.example",
    RESPONSE_RETENTION_TEXT: "Responses are retained for this demonstration and can be deleted on request.",
    RESEARCH_CONTACT_EMAIL: "researcher@example.com",
  } as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/server", () => ({
  getServiceSupabase: () => ({ from: mocks.from, rpc: mocks.rpc }),
  resetSupabaseForTests: vi.fn(),
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getEnv: () => mocks.env,
    requireLiveConfig: () => mocks.env,
    requireSecret: () => SESSION_SECRET,
  };
});

vi.mock("@/lib/providers/prolific", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/prolific")>();
  return {
    ...actual,
    createProlificClient: () => ({ validateSubmission: mocks.validateSubmission }),
  };
});

import { POST as submitRoute } from "@/app/api/surveys/[id]/submit/route";
import { type SurveySpec } from "@/lib/domain/schemas";
import { AppError } from "@/lib/errors";
import {
  participantCookieName,
  requireParticipantSession,
  setParticipantCookie,
} from "@/lib/security/auth";
import {
  participantFingerprint,
  signSession,
  verifySession,
} from "@/lib/security/crypto";
import {
  participantIdentifiersSchema,
  submitParticipantResponse,
  validateInitialParticipant,
} from "@/lib/services/participants";

const survey: SurveySpec = {
  title: "A short opinion survey",
  intro: "Please answer three short questions about your experience.",
  estimatedMinutes: 3,
  questions: [
    { ref: "helpful", type: "yes_no", title: "Was this helpful?", required: true },
    {
      ref: "priority",
      type: "multiple_choice",
      title: "What matters most?",
      required: true,
      choices: ["Speed", "Clarity", "Trust"],
    },
    {
      ref: "comment",
      type: "short_text",
      title: "What should improve?",
      description: "Do not include names or contact details.",
      required: true,
    },
  ],
};

const validAnswers = {
  helpful: "Yes",
  priority: "Clarity",
  comment: "Make the next step easier to see.",
};

beforeEach(() => {
  mocks.tableQueues.clear();
  mocks.rpcQueues.clear();
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  mocks.validateSubmission.mockReset();
  mocks.env.RESEARCH_CONTACT_EMAIL = "researcher@example.com";

  mocks.from.mockImplementation((table: string) => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(async () => {
      const queued = mocks.tableQueues.get(table)?.shift();
      if (!queued) throw new Error(`No mocked ${table} result remains.`);
      return queued;
    });
    return builder;
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    const queued = mocks.rpcQueues.get(name)?.shift();
    if (!queued) throw new Error(`No mocked ${name} RPC result remains.`);
    return queued;
  });
});

describe("participant identifier and signed-session boundary", () => {
  it("rejects missing, short, and uppercase raw Prolific identifiers", () => {
    expect(
      participantIdentifiersSchema.safeParse({
        participantId: PARTICIPANT_ID,
        prolificStudyId: PROLIFIC_STUDY_ID,
        submissionId: "short",
      }).success,
    ).toBe(false);
    expect(
      participantIdentifiersSchema.safeParse({
        participantId: PARTICIPANT_ID.toUpperCase(),
        prolificStudyId: PROLIFIC_STUDY_ID,
        submissionId: SUBMISSION_ID,
      }).success,
    ).toBe(false);
    expect(
      participantIdentifiersSchema.safeParse({
        participantId: PARTICIPANT_ID,
        prolificStudyId: PROLIFIC_STUDY_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects a URL study ID that differs from the stored external study before calling Prolific", async () => {
    queueTable("studies", {
      data: initialStudyRow("d".repeat(24)),
      error: null,
    });
    queueTable("participant_responses", { data: null, error: null });

    await expect(validateInitialParticipant(LOCAL_STUDY_ID, identifiers())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.validateSubmission).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("uses a domain-separated, study-bound HttpOnly cookie with API-compatible path", () => {
    const fingerprint = participantFingerprint(
      SESSION_SECRET,
      PARTICIPANT_ID,
      PROLIFIC_STUDY_ID,
      SUBMISSION_ID,
    );
    const expiresAt = new Date(Date.now() + 60_000);
    const response = NextResponse.json({ ok: true });
    setParticipantCookie(response, LOCAL_STUDY_ID, fingerprint, expiresAt);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");

    const token = setCookie.split(";")[0]?.split("=").slice(1).join("=");
    expect(token).toBeTruthy();
    const request = new NextRequest(`https://surveyor.example/survey/${LOCAL_STUDY_ID}`, {
      headers: { cookie: `${participantCookieName(LOCAL_STUDY_ID)}=${token}` },
    });
    expect(requireParticipantSession(request, LOCAL_STUDY_ID)).toMatchObject({
      kind: "participant",
      studyId: LOCAL_STUDY_ID,
      fingerprint,
    });
    expect(() => requireParticipantSession(request, OTHER_LOCAL_STUDY_ID)).toThrowError(AppError);

    const signed = signSession(
      {
        kind: "participant",
        studyId: LOCAL_STUDY_ID,
        fingerprint,
        exp: Math.floor(expiresAt.getTime() / 1_000),
      },
      SESSION_SECRET,
    );
    expect(verifySession(signed, "participant", SESSION_SECRET).studyId).toBe(LOCAL_STUDY_ID);
    expect(() => verifySession(signed, "event", SESSION_SECRET)).toThrowError(AppError);
  });
});

describe("completed revisit restrictions", () => {
  it("blocks a local completion when Prolific still reports ACTIVE", async () => {
    queueTable("studies", { data: initialStudyRow(), error: null });
    queueTable("participant_responses", { data: existingCompletedIdentity(), error: null });
    mocks.validateSubmission.mockResolvedValue(
      providerValidation("completed_revisit", "ACTIVE"),
    );

    await expect(validateInitialParticipant(LOCAL_STUDY_ID, identifiers())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["AWAITING REVIEW", "APPROVED"] as const)(
    "restores only the same completed response when Prolific reports %s",
    async (providerStatus) => {
      queueTable("studies", { data: initialStudyRow(), error: null });
      queueTable("participant_responses", { data: existingCompletedIdentity(), error: null });
      queueTable("studies", {
        data: { survey_spec: survey, prolific_completion_code: "DONE123" },
        error: null,
      });
      queueTable("participant_responses", {
        data: { status: "completed", consented_at: new Date().toISOString() },
        error: null,
      });
      queueRpc("begin_participant_response", {
        data: {
          responseId: "323e4567-e89b-12d3-a456-426614174000",
          created: false,
          status: "completed",
          consented: true,
          completed: true,
        },
        error: null,
      });
      mocks.validateSubmission.mockResolvedValue(
        providerValidation("completed_revisit", providerStatus),
      );

      const result = await validateInitialParticipant(LOCAL_STUDY_ID, identifiers());
      expect(result.state).toMatchObject({
        phase: "completed",
        completionCode: "DONE123",
        completionUrl: "https://app.prolific.com/submissions/complete?cc=DONE123",
      });
      expect(result.cookieExpiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(mocks.rpc).toHaveBeenCalledWith(
        "begin_participant_response",
        expect.objectContaining({ p_provider_status: providerStatus }),
      );
    },
  );
});

describe("submission idempotency, validation, and privacy", () => {
  it("reconstructs the same completion for an identical idempotent submit", async () => {
    queueTable("studies", {
      data: { survey_spec: survey, prolific_completion_code: "DONE123" },
      error: null,
    });
    queueRpc("submit_participant_response", {
      data: {
        applied: false,
        responseId: "323e4567-e89b-12d3-a456-426614174000",
        reportBecameReady: false,
        completionCode: "DONE123",
      },
      error: null,
    });

    const result = await submitParticipantResponse(LOCAL_STUDY_ID, FINGERPRINT, validAnswers);
    expect(result).toEqual({
      applied: false,
      reportBecameReady: false,
      completionCode: "DONE123",
      completionUrl: "https://app.prolific.com/submissions/complete?cc=DONE123",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "submit_participant_response",
      expect.objectContaining({
        p_study_id: LOCAL_STUDY_ID,
        p_participant_session_fingerprint: FINGERPRINT,
        p_answers: validAnswers,
        p_readable_summary: expect.any(Array),
      }),
    );
  });

  it("maps a differing duplicate to a safe conflict", async () => {
    queueTable("studies", {
      data: { survey_spec: survey, prolific_completion_code: "DONE123" },
      error: null,
    });
    queueRpc("submit_participant_response", {
      data: null,
      error: { code: "P0001", message: "DIFFERING_DUPLICATE_SUBMISSION" },
    });

    await expect(
      submitParticipantResponse(LOCAL_STUDY_ID, FINGERPRINT, validAnswers),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "This response was already submitted with different answers.",
    });
  });

  it("rejects contact details before invoking the submission RPC", async () => {
    queueTable("studies", {
      data: { survey_spec: survey, prolific_completion_code: "DONE123" },
      error: null,
    });

    await expect(
      submitParticipantResponse(LOCAL_STUDY_ID, FINGERPRINT, {
        ...validAnswers,
        comment: "Email me at private@example.com",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 422,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "submit_participant_response",
      expect.anything(),
    );
  });

  it("returns only completion data from the participant API, never provider IDs or fingerprints", async () => {
    queueRpc("consume_rate_limit", { data: true, error: null });
    queueTable("studies", {
      data: { survey_spec: survey, prolific_completion_code: "DONE123" },
      error: null,
    });
    queueRpc("submit_participant_response", {
      data: {
        applied: true,
        responseId: "323e4567-e89b-12d3-a456-426614174000",
        reportBecameReady: false,
        completedCount: 1,
        completionCode: "DONE123",
      },
      error: null,
    });
    const token = signSession(
      {
        kind: "participant",
        studyId: LOCAL_STUDY_ID,
        fingerprint: FINGERPRINT,
        exp: Math.floor(Date.now() / 1_000) + 60,
      },
      SESSION_SECRET,
    );
    const request = new NextRequest(
      `https://surveyor.example/api/surveys/${LOCAL_STUDY_ID}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://surveyor.example",
          host: "surveyor.example",
          "sec-fetch-site": "same-origin",
          cookie: `${participantCookieName(LOCAL_STUDY_ID)}=${token}`,
        },
        body: JSON.stringify({ answers: validAnswers, requestId: crypto.randomUUID() }),
      },
    );

    const response = await submitRoute(request, {
      params: Promise.resolve({ id: LOCAL_STUDY_ID }),
    });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toEqual({
      completed: true,
      completionUrl: "https://app.prolific.com/submissions/complete?cc=DONE123",
      completionCode: "DONE123",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(PARTICIPANT_ID);
    expect(serialized).not.toContain(PROLIFIC_STUDY_ID);
    expect(serialized).not.toContain(SUBMISSION_ID);
    expect(serialized).not.toContain(FINGERPRINT);
  });
});

function identifiers() {
  return {
    participantId: PARTICIPANT_ID,
    prolificStudyId: PROLIFIC_STUDY_ID,
    submissionId: SUBMISSION_ID,
  };
}

function initialStudyRow(prolificStudyId = PROLIFIC_STUDY_ID) {
  return {
    id: LOCAL_STUDY_ID,
    prolific_study_id: prolificStudyId,
    prolific_completion_code: "DONE123",
    estimated_minutes: 3,
    manual_finish_at: null,
    pause_cutoff_at: null,
  };
}

function existingCompletedIdentity() {
  return {
    status: "completed",
    prolific_participant_id: PARTICIPANT_ID,
    prolific_study_id: PROLIFIC_STUDY_ID,
    participant_session_fingerprint: participantFingerprint(
      SESSION_SECRET,
      PARTICIPANT_ID,
      PROLIFIC_STUDY_ID,
      SUBMISSION_ID,
    ),
  };
}

function providerValidation(
  kind: "collect" | "completed_revisit" | "terminal",
  status: string,
) {
  return {
    data: {
      kind,
      submission: {
        id: SUBMISSION_ID,
        participant: PARTICIPANT_ID,
        study_id: PROLIFIC_STUDY_ID,
        status,
        started_at: new Date(Date.now() - 30_000).toISOString(),
        completed_at: status === "ACTIVE" ? null : new Date().toISOString(),
        entered_code: status === "ACTIVE" ? null : "DONE123",
      },
    },
    evidence: {},
  };
}

function queueTable(table: string, result: { data: unknown; error: unknown }): void {
  const queue = mocks.tableQueues.get(table) ?? [];
  queue.push(result);
  mocks.tableQueues.set(table, queue);
}

function queueRpc(name: string, result: { data: unknown; error: unknown }): void {
  const queue = mocks.rpcQueues.get(name) ?? [];
  queue.push(result);
  mocks.rpcQueues.set(name, queue);
}

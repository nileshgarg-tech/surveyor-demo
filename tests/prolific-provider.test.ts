import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { ProviderError } from "@/lib/providers/http";
import {
  ProlificClient,
  assertActionableProlificStudyStatus,
  buildProlificStudyPayload,
  classifyProlificStudyStatus,
  resetProlificCacheForTests,
  sanitizeProlificMetadata,
} from "@/lib/providers/prolific";

const PROJECT_ID = "d".repeat(24);
const STUDY_ID = "a".repeat(24);
const SECOND_STUDY_ID = "e".repeat(24);
const SUBMISSION_ID = "b".repeat(24);
const PARTICIPANT_ID = "c".repeat(24);
const LOCAL_STUDY_ID = "123e4567-e89b-12d3-a456-426614174000";
const WORKSPACE_ID = "workspace-demo";
const NOW = new Date("2026-08-03T12:00:00.000Z");

type FetchHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  ) as unknown as typeof fetch;
}

function json(body: unknown, status = 200, requestId?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof ProlificClient>[0]> = {}) {
  return new ProlificClient({
    apiToken: "test-token-never-log",
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    appUrl: "https://surveyor.example",
    expectedCurrency: "USD",
    fetchImpl,
    maxRetries: 0,
    pageSize: 2,
    maxPages: 5,
    filterCacheTtlMs: 0,
    now: () => NOW,
    ...overrides,
  });
}

function study(
  id = STUDY_ID,
  status = "UNPUBLISHED",
  internalName: string | null = `surveyor-demo:${LOCAL_STUDY_ID}`,
) {
  return {
    id,
    status,
    internal_name: internalName,
    metadata: LOCAL_STUDY_ID,
    project: PROJECT_ID,
    is_ready_to_publish: true,
    name: "A short survey",
    total_available_places: 10,
    reward: 60,
    provider_extra_field: "ignored by the projection adapter",
  };
}

function studyShort(id = STUDY_ID, internalName: string | null = `surveyor-demo:${LOCAL_STUDY_ID}`) {
  return {
    id,
    status: "UNPUBLISHED",
    internal_name: internalName,
    is_ready_to_publish: true,
    total_cost: 800,
  };
}

function submission(
  status = "ACTIVE",
  startedAt = "2026-08-03T11:30:00.000Z",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: SUBMISSION_ID,
    participant: PARTICIPANT_ID,
    study_id: STUDY_ID,
    status,
    started_at: startedAt,
    completed_at: status === "ACTIVE" || status === "RESERVED" ? null : "2026-08-03T11:35:00.000Z",
    entered_code: status === "ACTIVE" || status === "RESERVED" ? null : "DONE123",
    ...overrides,
  };
}

function submissionShort(id: string, status: string, startedAt: string) {
  return {
    id,
    participant_id: PARTICIPANT_ID,
    status,
    started_at: startedAt,
    completed_at: status === "ACTIVE" || status === "RESERVED" ? null : "2026-08-03T11:50:00.000Z",
    has_siblings: false,
  };
}

beforeEach(() => {
  resetProlificCacheForTests();
});

describe("Prolific create-study contract", () => {
  it("builds the exact paid-study payload with unescaped identifiers and the documented time formula", () => {
    const payload = buildProlificStudyPayload({
      localStudyId: LOCAL_STUDY_ID,
      name: "A short survey",
      description: "Share a few opinions in this short research survey.",
      appUrl: "https://surveyor.example",
      totalAvailablePlaces: 10,
      estimatedMinutes: 3,
      rewardCents: 60,
      completionCode: "DONE123",
      filters: [
        { type: "select", filterId: "country", choiceIds: ["1", "2"] },
        { type: "range", filterId: "age", min: 25, max: 44 },
      ],
      projectId: PROJECT_ID,
    });

    expect(payload).toEqual({
      name: "A short survey",
      internal_name: `surveyor-demo:${LOCAL_STUDY_ID}`,
      description: "Share a few opinions in this short research survey.",
      external_study_url:
        `https://surveyor.example/survey/${LOCAL_STUDY_ID}` +
        "?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}",
      prolific_id_option: "url_parameters",
      total_available_places: 10,
      estimated_completion_time: 3,
      maximum_allowed_time: 12,
      reward: 60,
      completion_codes: [
        {
          code: "DONE123",
          code_type: "COMPLETED",
          actions: [{ action: "AUTOMATICALLY_APPROVE" }],
          actor: "participant",
        },
      ],
      device_compatibility: ["desktop", "mobile"],
      peripheral_requirements: [],
      filters: [
        { filter_id: "country", selected_values: ["1", "2"] },
        { filter_id: "age", selected_range: { lower: 25, upper: 44 } },
      ],
      project: PROJECT_ID,
      metadata: LOCAL_STUDY_ID,
      submissions_config: { max_submissions_per_participant: 1 },
    });
    expect(payload).not.toHaveProperty("workspace_id");
    expect(payload).not.toHaveProperty("completion_code");
  });

  it("sends create exactly once and preserves only sanitized evidence", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async (url, init) => {
      calls += 1;
      expect(url.pathname).toBe("/api/v1/studies/");
      expect(init.headers).toMatchObject({
        Authorization: "Token test-token-never-log",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.project).toBe(PROJECT_ID);
      expect(body).not.toHaveProperty("workspace_id");
      return json(study(), 201, "request-create-1");
    });
    const client = makeClient(fetchImpl);
    const result = await client.createStudy({
      localStudyId: LOCAL_STUDY_ID,
      name: "A short survey",
      description: "Share a few opinions in this short research survey.",
      totalAvailablePlaces: 10,
      estimatedMinutes: 3,
      rewardCents: 60,
      completionCode: "DONE123",
      filters: [],
    });

    expect(calls).toBe(1);
    expect(result.data.id).toBe(STUDY_ID);
    expect(result.evidence.requestId).toBe("request-create-1");
    const recorded = JSON.stringify(result.evidence);
    expect(recorded).not.toContain("test-token-never-log");
    expect(recorded).not.toContain("DONE123");
    expect(recorded).not.toContain("submissions/complete");
  });

  it("turns an uncertain create or transition into a non-retried ambiguous result", async () => {
    const createFetch = vi.fn(async () => {
      throw new TypeError("connection dropped");
    }) as unknown as typeof fetch;
    const createClient = makeClient(createFetch);
    await expect(
      createClient.createStudy({
        localStudyId: LOCAL_STUDY_ID,
        name: "A short survey",
        description: "Share a few opinions in this short research survey.",
        totalAvailablePlaces: 10,
        estimatedMinutes: 3,
        rewardCents: 60,
        completionCode: "DONE123",
        filters: [],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_AMBIGUOUS", retryable: true });
    expect(createFetch).toHaveBeenCalledTimes(1);

    const transitionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain(`/api/v1/studies/${STUDY_ID}/transition/`);
      expect(init?.method).toBe("POST");
      return json({ error: { code: "temporary" } }, 503);
    });
    const transitionClient = makeClient(transitionFetch as unknown as typeof fetch);
    await expect(transitionClient.publishStudy(STUDY_ID)).rejects.toMatchObject({
      code: "PROVIDER_AMBIGUOUS",
      retryable: true,
    });
    expect(transitionFetch).toHaveBeenCalledTimes(1);
    const transitionInit = transitionFetch.mock.calls[0]?.[1];
    expect(transitionInit).toBeDefined();
    expect(JSON.parse(String(transitionInit?.body))).toEqual({ action: "PUBLISH" });
  });
});

describe("live filter catalog", () => {
  it("keeps detailed workspace context while following a same-origin next link", async () => {
    const seen: URL[] = [];
    const fetchImpl = mockFetch((url) => {
      seen.push(url);
      if (seen.length === 1) {
        return json({
          results: [
            {
              filter_id: "country",
              title: "Country of residence",
              question: "Where do you live?",
              category: "Demographics",
              type: "select",
              data_type: "ChoiceID",
              choices: { "1": "United States", "2": "Canada" },
              researcher_help_text: "Extra documented metadata is tolerated by projection.",
            },
          ],
          _links: { next: "https://api.prolific.com/api/v1/filters/?cursor=opaque" },
          meta: { opaque: true },
        });
      }
      return json({
        results: [
          {
            filter_id: "age",
            title: "Age",
            question: "How old are you?",
            category: "Demographics",
            type: "range",
            data_type: "integer",
            min: 18,
            max: "100",
          },
        ],
        _links: { next: { href: null, title: "Next" } },
      });
    });
    const result = await makeClient(fetchImpl).fetchFilterCatalog();

    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual([
      {
        id: "country",
        title: "Country of residence",
        question: "Where do you live?",
        category: "Demographics",
        type: "select",
        choices: [
          { id: "1", label: "United States" },
          { id: "2", label: "Canada" },
        ],
        raw: { data_type: "ChoiceID" },
      },
      {
        id: "age",
        title: "Age",
        question: "How old are you?",
        category: "Demographics",
        type: "range",
        min: 18,
        max: 100,
        raw: { data_type: "integer", min: 18, max: "100" },
      },
    ]);
    expect(seen).toHaveLength(2);
    for (const url of seen) {
      expect(url.searchParams.get("workspace_id")).toBe(WORKSPACE_ID);
      expect(url.searchParams.get("detailed")).toBe("true");
    }
    expect(seen[1]?.searchParams.get("cursor")).toBe("opaque");
  });

  it("rejects cross-origin, changed-workspace, and cyclic next links", async () => {
    for (const next of [
      "https://attacker.example/api/v1/filters/?cursor=x",
      "https://api.prolific.com/api/v1/filters/?workspace_id=other",
      "https://api.prolific.com/api/v1/filters/?workspace_id=workspace-demo&detailed=true",
    ]) {
      resetProlificCacheForTests();
      let calls = 0;
      const fetchImpl = mockFetch(() => {
        calls += 1;
        return json({ results: [], _links: { next } });
      });
      await expect(makeClient(fetchImpl).fetchFilterCatalog()).rejects.toBeInstanceOf(ProviderError);
      expect(calls).toBe(next.includes("workspace-demo&detailed=true") ? 2 : 1);
    }
  });
});

describe("eligibility and authoritative preflight", () => {
  it("preserves Prolific's censored-zero semantics and sends simplified filters", async () => {
    const fetchImpl = mockFetch((_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({
        filters: [
          { filter_id: "country", selected_values: ["1"] },
          { filter_id: "age", selected_range: { lower: 25, upper: 44 } },
        ],
        workspace_id: WORKSPACE_ID,
      });
      return json({ count: 0 });
    });
    const result = await makeClient(fetchImpl).getEligibilityCount([
      { type: "select", filterId: "country", choiceIds: ["1"] },
      { type: "range", filterId: "age", min: 25, max: 44 },
    ]);
    expect(result.data).toEqual({
      reportedCount: 0,
      privacyCensoredBelow25: true,
      checkedAt: NOW.toISOString(),
    });
  });

  it("uses exact cost, balance, currency, and project ownership as preflight authority", async () => {
    const fetchImpl = mockFetch((url, init) => {
      if (url.pathname === "/api/v1/study-cost-calculator/") {
        expect(JSON.parse(String(init.body))).toEqual({ reward: 60, total_available_places: 10 });
        return json({ total_cost: 800, extra: "ignored" }, 200, "cost-request");
      }
      if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}/balance/`) {
        return json({ currency_code: "USD", available_balance: 10_000, balance_breakdown: {} });
      }
      if (url.pathname === `/api/v1/projects/${PROJECT_ID}/`) {
        return json({ id: PROJECT_ID, workspace: WORKSPACE_ID, title: "Demo project" });
      }
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const result = await makeClient(fetchImpl).preflightCost(60, 10);
    expect(result).toMatchObject({
      authoritativeTotalCents: 800,
      currencyCode: "USD",
      availableBalanceCents: 10_000,
      checkedAt: NOW.toISOString(),
    });
    expect(result.evidence).toHaveLength(3);
  });

  it.each([
    ["currency", { currency_code: "GBP", available_balance: 10_000 }, WORKSPACE_ID, "SETUP_REQUIRED"],
    ["balance", { currency_code: "USD", available_balance: 799 }, WORKSPACE_ID, "FORBIDDEN"],
    ["ownership", { currency_code: "USD", available_balance: 10_000 }, "other-workspace", "SETUP_REQUIRED"],
  ])("fails closed on invalid %s preflight evidence", async (_case, balance, projectWorkspace, code) => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === "/api/v1/study-cost-calculator/") return json({ total_cost: 800 });
      if (url.pathname.includes("/balance/")) return json(balance);
      return json({ id: PROJECT_ID, workspace: projectWorkspace });
    });
    await expect(makeClient(fetchImpl).preflightCost(60, 10)).rejects.toMatchObject({ code });
  });

  it("rejects fractional provider money instead of rounding authorization values", async () => {
    const fetchImpl = mockFetch(() => json({ total_cost: 800.5 }));
    await expect(makeClient(fetchImpl).calculateStudyCost(60, 10)).rejects.toMatchObject({
      code: "SCHEMA_DRIFT",
    });
  });
});

describe("study statuses and reconciliation", () => {
  it("classifies exact wire statuses and blocks scheduled/unknown branches", () => {
    expect(classifyProlificStudyStatus("UNPUBLISHED")).toBe("unpublished_draft");
    expect(classifyProlificStudyStatus("PUBLISHING")).toBe("paid_or_publishing");
    expect(classifyProlificStudyStatus("AWAITING REVIEW")).toBe("paid_non_recruiting");
    expect(classifyProlificStudyStatus("SCHEDULED")).toBe("blocked_unknown");
    expect(classifyProlificStudyStatus("UNKNOWN")).toBe("blocked_unknown");
    expect(() => assertActionableProlificStudyStatus("UNKNOWN")).toThrowError(AppError);
  });

  it("scans every project page, then verifies metadata on the unique exact-name match", async () => {
    const seenPages: string[] = [];
    const fetchImpl = mockFetch((url) => {
      if (url.pathname.endsWith("/studies/") && url.pathname.includes("/projects/")) {
        const page = url.searchParams.get("page") ?? "";
        seenPages.push(page);
        return page === "1" ? json({ results: [studyShort()] }) : json({ results: [] });
      }
      if (url.pathname === `/api/v1/studies/${STUDY_ID}/`) return json(study());
      throw new Error(`Unexpected request ${url.href}`);
    });
    const result = await makeClient(fetchImpl, { pageSize: 1 }).reconcileStudyByIdentity(LOCAL_STUDY_ID);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.study.metadata).toBe(LOCAL_STUDY_ID);
    expect(seenPages).toEqual(["1", "2"]);
  });

  it("returns absent only after a complete scan and blocks duplicate exact names", async () => {
    const absentFetch = mockFetch(() => json({ results: [] }));
    await expect(makeClient(absentFetch, { pageSize: 1 }).reconcileStudyByIdentity(LOCAL_STUDY_ID)).resolves.toEqual({
      kind: "absent",
      evidence: [expect.any(Object)],
    });

    const duplicateFetch = mockFetch((url) => {
      const page = url.searchParams.get("page");
      if (page === "1") return json({ results: [studyShort(STUDY_ID)] });
      if (page === "2") return json({ results: [studyShort(SECOND_STUDY_ID)] });
      return json({ results: [] });
    });
    await expect(
      makeClient(duplicateFetch, { pageSize: 1 }).reconcileStudyByIdentity(LOCAL_STUDY_ID),
    ).rejects.toMatchObject({ code: "PROVIDER_AMBIGUOUS", details: { matchCount: 2 } });
  });

  it("rejects an undocumented study status as schema drift", async () => {
    const fetchImpl = mockFetch(() => json(study(STUDY_ID, "RUNNING")));
    await expect(makeClient(fetchImpl).getStudy(STUDY_ID)).rejects.toMatchObject({
      code: "SCHEMA_DRIFT",
    });
  });
});

describe("submission validation, reconciliation, and approval", () => {
  it("requires exact IDs, collection status, and a pre-pause start time", async () => {
    const activeClient = makeClient(mockFetch(() => json(submission("ACTIVE"))));
    const active = await activeClient.validateSubmission({
      submissionId: SUBMISSION_ID,
      studyId: STUDY_ID,
      participantId: PARTICIPANT_ID,
      localResponseCompleted: false,
      pauseCutoff: "2026-08-03T11:45:00.000Z",
    });
    expect(active.data.kind).toBe("collect");

    const mismatchClient = makeClient(
      mockFetch(() => json(submission("ACTIVE", undefined, { participant: "f".repeat(24) }))),
    );
    await expect(
      mismatchClient.validateSubmission({
        submissionId: SUBMISSION_ID,
        studyId: STUDY_ID,
        participantId: PARTICIPANT_ID,
        localResponseCompleted: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const lateClient = makeClient(mockFetch(() => json(submission("RESERVED", "2026-08-03T11:46:00.000Z"))));
    await expect(
      lateClient.validateSubmission({
        submissionId: SUBMISSION_ID,
        studyId: STUDY_ID,
        participantId: PARTICIPANT_ID,
        localResponseCompleted: false,
        pauseCutoff: "2026-08-03T11:45:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("restores a completed participant only for matching completed local state", async () => {
    const client = makeClient(mockFetch(() => json(submission("AWAITING REVIEW"))));
    const revisiting = await client.validateSubmission({
      submissionId: SUBMISSION_ID,
      studyId: STUDY_ID,
      participantId: PARTICIPANT_ID,
      localResponseCompleted: true,
    });
    expect(revisiting.data.kind).toBe("completed_revisit");

    const unmatched = await client.validateSubmission({
      submissionId: SUBMISSION_ID,
      studyId: STUDY_ID,
      participantId: PARTICIPANT_ID,
      localResponseCompleted: false,
    });
    expect(unmatched.data.kind).toBe("terminal");
  });

  it("lists all submissions without an unsupported RESERVED query filter", async () => {
    const first = SUBMISSION_ID;
    const second = "1".repeat(24);
    const third = "2".repeat(24);
    const seen: URL[] = [];
    const fetchImpl = mockFetch((url) => {
      seen.push(url);
      return url.searchParams.get("page") === "1"
        ? json({
            results: [
              submissionShort(first, "RESERVED", "2026-08-03T11:20:00.000Z"),
              submissionShort(second, "ACTIVE", "2026-08-03T11:30:00.000Z"),
            ],
          })
        : json({ results: [submissionShort(third, "RETURNED", "2026-08-03T11:40:00.000Z")] });
    });
    const result = await makeClient(fetchImpl).listSubmissions(STUDY_ID);
    expect(result.data.map((item) => item.id)).toEqual([first, second, third]);
    expect(seen).toHaveLength(2);
    for (const url of seen) {
      expect(url.searchParams.get("study")).toBe(STUDY_ID);
      expect(url.searchParams.has("status")).toBe(false);
    }
  });

  it("approves only an awaiting-review submission and never uses COMPLETE", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = mockFetch((url, init) => {
      calls.push({ url, init });
      if (init.method === "GET") return json(submission("AWAITING REVIEW"));
      return json(submission("APPROVED"));
    });
    const result = await makeClient(fetchImpl).approveSubmission(SUBMISSION_ID);
    expect(result.data.status).toBe("APPROVED");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ action: "APPROVE" });
  });
});

describe("provider metadata sanitization", () => {
  it("redacts credentials, completion routes, participant IDs, and answer text", () => {
    const sanitized = sanitizeProlificMetadata({
      Authorization: "Token secret",
      completion_codes: [{ code: "DONE123" }],
      external_study_url: "https://example.test/survey?id=secret",
      participant_id: PARTICIPANT_ID,
      answers: { q1: "private text" },
      status: "ACTIVE",
    });
    expect(sanitized).toEqual({
      Authorization: "[REDACTED]",
      completion_codes: "[REDACTED]",
      external_study_url: "[REDACTED]",
      participant_id: "[REDACTED]",
      answers: "[REDACTED]",
      status: "ACTIVE",
    });
  });
});

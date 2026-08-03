import { z, type ZodType } from "zod";
import {
  type NormalizedCatalogFilter,
  type ParticipantCount,
  type ValidatedProlificFilter,
  participantCountSchema,
  validatedProlificFilterSchema,
} from "@/lib/domain/schemas";
import {
  type CostPreflight,
  maximumAllowedTimeMinutes,
  parseProviderCents,
} from "@/lib/domain/money";
import { AppError } from "@/lib/errors";
import { requireLiveConfig } from "@/lib/env";
import {
  ProviderError,
  type ProviderJsonResponse,
  requestProviderJson,
} from "@/lib/providers/http";

export const PROLIFIC_API_BASE_URL = "https://api.prolific.com";
export const PROLIFIC_FILTER_CACHE_TTL_MS = 60_000;
export const PROLIFIC_DEFAULT_PAGE_SIZE = 100;
export const PROLIFIC_DEFAULT_MAX_PAGES = 100;

export const prolificIdSchema = z.string().regex(/^[a-f\d]{24}$/);
export const prolificStudyStatusSchema = z.enum([
  "UNPUBLISHED",
  "SCHEDULED",
  "PUBLISHING",
  "ACTIVE",
  "AWAITING REVIEW",
  "PAUSED",
  "COMPLETED",
  "UNKNOWN",
]);
export type ProlificStudyStatus = z.infer<typeof prolificStudyStatusSchema>;

export const prolificSubmissionStatusSchema = z.enum([
  "ACTIVE",
  "APPROVED",
  "PARTIALLY APPROVED",
  "AWAITING REVIEW",
  "REJECTED",
  "RESERVED",
  "RETURNED",
  "TIMED-OUT",
  "SCREENED OUT",
  "UNKNOWN",
]);
export type ProlificSubmissionStatus = z.infer<typeof prolificSubmissionStatusSchema>;

export const prolificStudyActionSchema = z.enum(["PUBLISH", "PAUSE", "START", "STOP"]);
export type ProlificStudyAction = z.infer<typeof prolificStudyActionSchema>;

const selectedFilterPayloadSchema = z.strictObject({
  filter_id: z.string().min(1),
  selected_values: z.array(z.string().min(1)).min(1),
});

const rangeFilterPayloadSchema = z.strictObject({
  filter_id: z.string().min(1),
  selected_range: z.strictObject({
    lower: z.number().finite().nullable().optional(),
    upper: z.number().finite().nullable().optional(),
  }),
});

export const prolificFilterPayloadSchema = z.union([
  selectedFilterPayloadSchema,
  rangeFilterPayloadSchema,
]);
export type ProlificFilterPayload = z.infer<typeof prolificFilterPayloadSchema>;

export const prolificCreateStudyPayloadSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  internal_name: z.string().regex(/^surveyor-demo:[0-9a-f-]{36}$/),
  description: z.string().trim().min(1).max(10_000),
  external_study_url: z.url(),
  prolific_id_option: z.literal("url_parameters"),
  total_available_places: participantCountSchema,
  estimated_completion_time: z.number().int().min(1).max(5),
  maximum_allowed_time: z.number().int().positive(),
  reward: z.number().int().positive(),
  completion_codes: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(64),
        code_type: z.literal("COMPLETED"),
        actions: z.tuple([z.strictObject({ action: z.literal("AUTOMATICALLY_APPROVE") })]),
        actor: z.literal("participant"),
      }),
    )
    .length(1),
  device_compatibility: z.tuple([z.literal("desktop"), z.literal("mobile")]),
  peripheral_requirements: z.array(z.never()).length(0),
  filters: z.array(prolificFilterPayloadSchema).max(20),
  project: prolificIdSchema,
  metadata: z.uuid(),
  submissions_config: z.strictObject({ max_submissions_per_participant: z.literal(1) }),
});
export type ProlificCreateStudyPayload = z.infer<typeof prolificCreateStudyPayloadSchema>;

export const prolificStudySchema = z.strictObject({
  id: prolificIdSchema,
  status: prolificStudyStatusSchema,
  internal_name: z.string().nullable(),
  metadata: z.string().nullable(),
  project: prolificIdSchema,
  is_ready_to_publish: z.boolean(),
  name: z.string().optional(),
  total_available_places: z.number().int().nonnegative().optional(),
  reward: z.number().int().nonnegative().optional(),
});
export type ProlificStudy = z.infer<typeof prolificStudySchema>;

export const prolificStudyShortSchema = z.strictObject({
  id: prolificIdSchema,
  status: prolificStudyStatusSchema,
  internal_name: z.string().nullable(),
  is_ready_to_publish: z.boolean(),
});
export type ProlificStudyShort = z.infer<typeof prolificStudyShortSchema>;

export const prolificSubmissionSchema = z.strictObject({
  id: prolificIdSchema,
  participant: prolificIdSchema,
  study_id: prolificIdSchema,
  status: prolificSubmissionStatusSchema,
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
  entered_code: z.string().nullable(),
});
export type ProlificSubmission = z.infer<typeof prolificSubmissionSchema>;

export const prolificSubmissionShortSchema = z.strictObject({
  id: prolificIdSchema,
  participant_id: prolificIdSchema,
  status: prolificSubmissionStatusSchema,
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
});
export type ProlificSubmissionShort = z.infer<typeof prolificSubmissionShortSchema>;

export type SanitizedProviderMetadata =
  | null
  | boolean
  | number
  | string
  | SanitizedProviderMetadata[]
  | { [key: string]: SanitizedProviderMetadata };

export type ProlificEvidence = {
  operation: string;
  method: string;
  path: string;
  httpStatus: number;
  request: SanitizedProviderMetadata;
  response: SanitizedProviderMetadata;
  requestId?: string;
};

export type ProlificResult<T> = {
  data: T;
  evidence: ProlificEvidence;
};

export type ProlificPagedResult<T> = {
  data: T;
  evidence: ProlificEvidence[];
};

export type ProlificCatalogResult = ProlificPagedResult<NormalizedCatalogFilter[]> & {
  fromCache: boolean;
};

export type ProlificStudyDisposition =
  | "unpublished_draft"
  | "paid_or_publishing"
  | "paid_non_recruiting"
  | "blocked_unknown";

export function classifyProlificStudyStatus(status: ProlificStudyStatus): ProlificStudyDisposition {
  switch (status) {
    case "UNPUBLISHED":
      return "unpublished_draft";
    case "PUBLISHING":
    case "ACTIVE":
      return "paid_or_publishing";
    case "PAUSED":
    case "AWAITING REVIEW":
    case "COMPLETED":
      return "paid_non_recruiting";
    case "SCHEDULED":
    case "UNKNOWN":
      return "blocked_unknown";
  }
}

export function assertActionableProlificStudyStatus(status: ProlificStudyStatus): void {
  if (classifyProlificStudyStatus(status) === "blocked_unknown") {
    throw new AppError("SCHEMA_DRIFT", "Prolific returned a study state that requires manual reconciliation.", {
      status: 502,
      details: { providerStatus: status },
    });
  }
}

const sensitiveMetadataKey = /(?:authorization|cookie|secret|token|completion(?:_|-)?code|entered(?:_|-)?code|external(?:_|-)?study(?:_|-)?url|participant(?:_|-)?(?:id)?|prolific(?:_|-)?pid|session(?:_|-)?id|study(?:_|-)?code|answers?|readable(?:_|-)?summary)/i;

export function sanitizeProlificMetadata(value: unknown, depth = 0): SanitizedProviderMetadata {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[INVALID_NUMBER]";
  if (typeof value === "string") return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeProlificMetadata(item, depth + 1));
  }
  if (!isRecord(value)) return `[${typeof value}]`;

  const output: Record<string, SanitizedProviderMetadata> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = sensitiveMetadataKey.test(key)
      ? "[REDACTED]"
      : sanitizeProlificMetadata(item, depth + 1);
  }
  return output;
}

export type BuildProlificStudyInput = {
  localStudyId: string;
  name: string;
  description: string;
  appUrl: string;
  totalAvailablePlaces: ParticipantCount;
  estimatedMinutes: number;
  rewardCents: number;
  completionCode: string;
  filters: readonly ValidatedProlificFilter[];
  projectId: string;
};

const buildStudyInputSchema = z.strictObject({
  localStudyId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(10_000),
  appUrl: z.url(),
  totalAvailablePlaces: participantCountSchema,
  estimatedMinutes: z.number().int().min(1).max(5),
  rewardCents: z.number().int().positive(),
  completionCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  filters: z.array(validatedProlificFilterSchema).max(20),
  projectId: prolificIdSchema,
});

export function toProlificFilters(filters: readonly ValidatedProlificFilter[]): ProlificFilterPayload[] {
  return filters.map((filter) => {
    const validated = validatedProlificFilterSchema.parse(filter);
    if (validated.type === "select") {
      return selectedFilterPayloadSchema.parse({
        filter_id: validated.filterId,
        selected_values: validated.choiceIds,
      });
    }
    return rangeFilterPayloadSchema.parse({
      filter_id: validated.filterId,
      selected_range: { lower: validated.min, upper: validated.max },
    });
  });
}

export function buildProlificStudyPayload(input: BuildProlificStudyInput): ProlificCreateStudyPayload {
  const validated = buildStudyInputSchema.parse(input);
  const surveyUrl = new URL(`/survey/${encodeURIComponent(validated.localStudyId)}`, validated.appUrl);
  surveyUrl.search = "";
  surveyUrl.hash = "";
  const externalStudyUrl = `${surveyUrl.toString()}?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`;

  return prolificCreateStudyPayloadSchema.parse({
    name: validated.name,
    internal_name: `surveyor-demo:${validated.localStudyId}`,
    description: validated.description,
    external_study_url: externalStudyUrl,
    prolific_id_option: "url_parameters",
    total_available_places: validated.totalAvailablePlaces,
    estimated_completion_time: validated.estimatedMinutes,
    maximum_allowed_time: maximumAllowedTimeMinutes(validated.estimatedMinutes),
    reward: validated.rewardCents,
    completion_codes: [
      {
        code: validated.completionCode,
        code_type: "COMPLETED",
        actions: [{ action: "AUTOMATICALLY_APPROVE" }],
        actor: "participant",
      },
    ],
    device_compatibility: ["desktop", "mobile"],
    peripheral_requirements: [],
    filters: toProlificFilters(validated.filters),
    project: validated.projectId,
    metadata: validated.localStudyId,
    submissions_config: { max_submissions_per_participant: 1 },
  });
}

export type CreateProlificStudyInput = Omit<BuildProlificStudyInput, "appUrl" | "projectId">;

export type ProlificClientOptions = {
  apiToken: string;
  workspaceId: string;
  projectId: string;
  appUrl: string;
  expectedCurrency?: string;
  apiBaseUrl?: string;
  maxRetries?: number;
  maxPages?: number;
  pageSize?: number;
  filterCacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
};

type ResolvedProlificClientOptions = {
  apiToken: string;
  workspaceId: string;
  projectId: string;
  appUrl: string;
  expectedCurrency: string;
  apiBaseUrl: URL;
  maxRetries: number;
  maxPages: number;
  pageSize: number;
  filterCacheTtlMs: number;
  fetchImpl: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now: () => Date;
};

type CachedCatalog = {
  expiresAt: number;
  data: NormalizedCatalogFilter[];
};

const catalogCache = new Map<string, CachedCatalog>();

export function resetProlificCacheForTests(): void {
  catalogCache.clear();
}

export function createProlificClient(overrides: Partial<ProlificClientOptions> = {}): ProlificClient {
  const env = requireLiveConfig([
    "PROLIFIC_API_TOKEN",
    "PROLIFIC_WORKSPACE_ID",
    "PROLIFIC_PROJECT_ID",
  ]);
  return new ProlificClient({
    apiToken: overrides.apiToken ?? env.PROLIFIC_API_TOKEN,
    workspaceId: overrides.workspaceId ?? env.PROLIFIC_WORKSPACE_ID,
    projectId: overrides.projectId ?? env.PROLIFIC_PROJECT_ID,
    appUrl: overrides.appUrl ?? env.NEXT_PUBLIC_APP_URL,
    expectedCurrency: overrides.expectedCurrency ?? env.EXPECTED_PROLIFIC_CURRENCY,
    apiBaseUrl: overrides.apiBaseUrl ?? PROLIFIC_API_BASE_URL,
    maxRetries: overrides.maxRetries ?? env.MAX_PROVIDER_RETRIES,
    ...(overrides.maxPages === undefined ? {} : { maxPages: overrides.maxPages }),
    ...(overrides.pageSize === undefined ? {} : { pageSize: overrides.pageSize }),
    ...(overrides.filterCacheTtlMs === undefined ? {} : { filterCacheTtlMs: overrides.filterCacheTtlMs }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
    ...(overrides.random === undefined ? {} : { random: overrides.random }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

export type EligibilityCount = {
  reportedCount: number;
  privacyCensoredBelow25: boolean;
  checkedAt: string;
};

export type CostPreflightResult = CostPreflight & {
  evidence: ProlificEvidence[];
};

export type ReconciledStudy =
  | { kind: "absent"; evidence: ProlificEvidence[] }
  | { kind: "found"; study: ProlificStudy; evidence: ProlificEvidence[] };

export type SubmissionAccess =
  | { kind: "collect"; submission: ProlificSubmission }
  | { kind: "completed_revisit"; submission: ProlificSubmission }
  | { kind: "terminal"; submission: ProlificSubmission };

export class ProlificClient {
  private readonly options: ResolvedProlificClientOptions;

  constructor(options: ProlificClientOptions) {
    const apiToken = z.string().trim().min(1).parse(options.apiToken);
    const workspaceId = z.string().trim().min(1).parse(options.workspaceId);
    const projectId = prolificIdSchema.parse(options.projectId);
    const appUrl = z.url().parse(options.appUrl);
    const expectedCurrency = z.string().trim().length(3).parse(options.expectedCurrency ?? "USD");
    const apiBaseUrl = new URL(options.apiBaseUrl ?? PROLIFIC_API_BASE_URL);
    if (apiBaseUrl.username || apiBaseUrl.password || apiBaseUrl.search || apiBaseUrl.hash) {
      throw new AppError("SETUP_REQUIRED", "The Prolific API base URL is invalid.", { status: 503 });
    }
    apiBaseUrl.pathname = "/";

    this.options = {
      apiToken,
      workspaceId,
      projectId,
      appUrl,
      expectedCurrency,
      apiBaseUrl,
      maxRetries: z.number().int().min(0).max(8).parse(options.maxRetries ?? 3),
      maxPages: z.number().int().min(1).max(1_000).parse(options.maxPages ?? PROLIFIC_DEFAULT_MAX_PAGES),
      pageSize: z.number().int().min(1).max(1_000).parse(options.pageSize ?? PROLIFIC_DEFAULT_PAGE_SIZE),
      filterCacheTtlMs: z.number().int().min(0).max(3_600_000).parse(
        options.filterCacheTtlMs ?? PROLIFIC_FILTER_CACHE_TTL_MS,
      ),
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now ?? (() => new Date()),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
    };
  }

  async fetchFilterCatalog(options: { filterTag?: string; bypassCache?: boolean } = {}): Promise<ProlificCatalogResult> {
    const filterTag = options.filterTag ? z.string().trim().min(1).parse(options.filterTag) : undefined;
    const cacheKey = `${this.options.apiBaseUrl.origin}|${this.options.workspaceId}|${filterTag ?? ""}`;
    const nowMs = this.options.now().getTime();
    const cached = catalogCache.get(cacheKey);
    if (!options.bypassCache && cached && cached.expiresAt > nowMs) {
      return { data: structuredClone(cached.data), evidence: [], fromCache: true };
    }

    const firstUrl = this.buildUrl("/api/v1/filters/", {
      detailed: "true",
      workspace_id: this.options.workspaceId,
      ...(filterTag ? { filter_tag: filterTag } : {}),
    });
    const visited = new Set<string>();
    const filters: NormalizedCatalogFilter[] = [];
    const evidence: ProlificEvidence[] = [];
    let nextUrl: URL | undefined = firstUrl;

    for (let page = 0; nextUrl && page < this.options.maxPages; page += 1) {
      if (visited.has(nextUrl.href)) {
        throw schemaDrift("Prolific filter pagination repeated a page.");
      }
      visited.add(nextUrl.href);
      const result = await this.request("filters.list", nextUrl, { method: "GET" }, undefined, true);
      evidence.push(result.evidence);
      const envelope = parseProjected(
        result.response.body,
        filterEnvelopeSchema,
        ["results", "_links", "meta"],
        "filter catalog",
      );
      filters.push(...envelope.results.map(adaptCatalogFilter));
      nextUrl = this.safeFilterNextUrl(extractNextLink(envelope._links), nextUrl, filterTag);
    }

    if (nextUrl) throw schemaDrift("Prolific filter pagination exceeded its safety limit.");
    const deduplicated = deduplicateCatalog(filters);
    catalogCache.set(cacheKey, {
      expiresAt: nowMs + this.options.filterCacheTtlMs,
      data: structuredClone(deduplicated),
    });
    return { data: deduplicated, evidence, fromCache: false };
  }

  async getEligibilityCount(filters: readonly ValidatedProlificFilter[]): Promise<ProlificResult<EligibilityCount>> {
    const payload = { filters: toProlificFilters(filters), workspace_id: this.options.workspaceId };
    const result = await this.request(
      "eligibility.count",
      this.buildUrl("/api/v1/eligibility-count/"),
      { method: "POST" },
      payload,
      true,
    );
    const body = parseProjected(result.response.body, eligibilitySchema, ["count"], "eligibility count");
    return {
      data: {
        reportedCount: body.count,
        privacyCensoredBelow25: body.count === 0,
        checkedAt: this.options.now().toISOString(),
      },
      evidence: result.evidence,
    };
  }

  async calculateStudyCost(
    rewardCents: number,
    totalAvailablePlaces: ParticipantCount,
  ): Promise<ProlificResult<number>> {
    const payload = costRequestSchema.parse({
      reward: rewardCents,
      total_available_places: totalAvailablePlaces,
    });
    const result = await this.request(
      "study.cost",
      this.buildUrl("/api/v1/study-cost-calculator/"),
      { method: "POST" },
      payload,
      true,
    );
    const body = parseProjected(result.response.body, costResponseSchema, ["total_cost"], "study cost");
    return { data: parseProviderCents(body.total_cost, "total_cost"), evidence: result.evidence };
  }

  async getWorkspaceBalance(): Promise<ProlificResult<{ currencyCode: string; availableBalanceCents: number }>> {
    const result = await this.request(
      "workspace.balance",
      this.buildUrl(`/api/v1/workspaces/${encodeURIComponent(this.options.workspaceId)}/balance/`),
      { method: "GET" },
      undefined,
      true,
    );
    const body = parseProjected(
      result.response.body,
      balanceSchema,
      ["currency_code", "available_balance"],
      "workspace balance",
    );
    return {
      data: {
        currencyCode: body.currency_code,
        availableBalanceCents: parseProviderCents(body.available_balance, "available_balance"),
      },
      evidence: result.evidence,
    };
  }

  async getProject(): Promise<ProlificResult<{ id: string; workspaceId: string }>> {
    const result = await this.request(
      "project.get",
      this.buildUrl(`/api/v1/projects/${this.options.projectId}/`),
      { method: "GET" },
      undefined,
      true,
    );
    const body = parseProjected(result.response.body, projectSchema, ["id", "workspace"], "project");
    return { data: { id: body.id, workspaceId: body.workspace }, evidence: result.evidence };
  }

  async preflightCost(
    rewardCents: number,
    totalAvailablePlaces: ParticipantCount,
  ): Promise<CostPreflightResult> {
    const [cost, balance, project] = await Promise.all([
      this.calculateStudyCost(rewardCents, totalAvailablePlaces),
      this.getWorkspaceBalance(),
      this.getProject(),
    ]);
    if (project.data.id !== this.options.projectId || project.data.workspaceId !== this.options.workspaceId) {
      throw new AppError("SETUP_REQUIRED", "The configured Prolific project does not belong to the workspace.", {
        status: 503,
      });
    }
    if (balance.data.currencyCode !== this.options.expectedCurrency) {
      throw new AppError(
        "SETUP_REQUIRED",
        `Prolific workspace currency must be ${this.options.expectedCurrency}.`,
        { status: 503 },
      );
    }
    if (balance.data.availableBalanceCents < cost.data) {
      throw new AppError("FORBIDDEN", "The Prolific workspace balance is too low for this study.", {
        status: 422,
      });
    }
    return {
      authoritativeTotalCents: cost.data,
      currencyCode: balance.data.currencyCode,
      availableBalanceCents: balance.data.availableBalanceCents,
      checkedAt: this.options.now().toISOString(),
      evidence: [cost.evidence, balance.evidence, project.evidence],
    };
  }

  buildStudyPayload(input: CreateProlificStudyInput): ProlificCreateStudyPayload {
    return buildProlificStudyPayload({
      ...input,
      appUrl: this.options.appUrl,
      projectId: this.options.projectId,
    });
  }

  async createStudy(input: CreateProlificStudyInput): Promise<ProlificResult<ProlificStudy>> {
    const payload = this.buildStudyPayload(input);
    const result = await this.request(
      "study.create",
      this.buildUrl("/api/v1/studies/"),
      { method: "POST" },
      payload,
      false,
    );
    this.requireStatus(result.response, [201], "study.create", payload);
    const study = this.parseStudyAfterMutation(result.response, "study.create", payload);
    if (
      study.internal_name !== payload.internal_name ||
      study.metadata !== payload.metadata ||
      study.project !== payload.project
    ) {
      throw ambiguousProviderResult("study.create", result.response, payload, "Prolific returned mismatched study identity.");
    }
    if (study.status !== "UNPUBLISHED") {
      throw ambiguousProviderResult(
        "study.create",
        result.response,
        payload,
        "Prolific did not return a confirmed unpublished draft.",
      );
    }
    return { data: study, evidence: result.evidence };
  }

  async getStudy(studyId: string): Promise<ProlificResult<ProlificStudy>> {
    const id = prolificIdSchema.parse(studyId);
    const result = await this.request(
      "study.get",
      this.buildUrl(`/api/v1/studies/${id}/`),
      { method: "GET" },
      undefined,
      true,
    );
    const study = parseStudy(result.response.body, "study");
    if (study.id !== id) throw schemaDrift("Prolific returned the wrong study.");
    assertActionableProlificStudyStatus(study.status);
    return { data: study, evidence: result.evidence };
  }

  async transitionStudy(studyId: string, action: ProlificStudyAction): Promise<ProlificResult<ProlificStudy>> {
    const id = prolificIdSchema.parse(studyId);
    const validatedAction = prolificStudyActionSchema.parse(action);
    const payload = { action: validatedAction };
    const result = await this.request(
      `study.${validatedAction.toLocaleLowerCase()}`,
      this.buildUrl(`/api/v1/studies/${id}/transition/`),
      { method: "POST" },
      payload,
      false,
    );
    this.requireStatus(result.response, [200], `study.${validatedAction.toLocaleLowerCase()}`, payload);
    const study = this.parseStudyAfterMutation(
      result.response,
      `study.${validatedAction.toLocaleLowerCase()}`,
      payload,
    );
    if (study.id !== id) {
      throw ambiguousProviderResult(
        `study.${validatedAction.toLocaleLowerCase()}`,
        result.response,
        payload,
        "Prolific returned the wrong study after a transition.",
      );
    }
    assertActionableProlificStudyStatus(study.status);
    return { data: study, evidence: result.evidence };
  }

  publishStudy(studyId: string): Promise<ProlificResult<ProlificStudy>> {
    return this.transitionStudy(studyId, "PUBLISH");
  }

  pauseStudy(studyId: string): Promise<ProlificResult<ProlificStudy>> {
    return this.transitionStudy(studyId, "PAUSE");
  }

  stopStudy(studyId: string): Promise<ProlificResult<ProlificStudy>> {
    return this.transitionStudy(studyId, "STOP");
  }

  async deleteUnpublishedStudy(studyId: string): Promise<ProlificPagedResult<null>> {
    const current = await this.getStudy(studyId);
    if (current.data.status !== "UNPUBLISHED") {
      throw new AppError("CONFLICT", "Only a confirmed unpublished Prolific draft can be deleted.", {
        status: 409,
      });
    }
    const result = await this.request(
      "study.delete",
      this.buildUrl(`/api/v1/studies/${current.data.id}/`),
      { method: "DELETE" },
      undefined,
      false,
    );
    this.requireStatus(result.response, [200], "study.delete");
    return { data: null, evidence: [current.evidence, result.evidence] };
  }

  async listProjectStudies(): Promise<ProlificPagedResult<ProlificStudyShort[]>> {
    const studies = new Map<string, ProlificStudyShort>();
    const evidence: ProlificEvidence[] = [];
    let completed = false;

    for (let page = 1; page <= this.options.maxPages; page += 1) {
      const result = await this.request(
        "project.studies",
        this.buildUrl(`/api/v1/projects/${this.options.projectId}/studies/`, {
          page: String(page),
          page_size: String(this.options.pageSize),
          ordering: "-date_created",
        }),
        { method: "GET" },
        undefined,
        true,
      );
      evidence.push(result.evidence);
      const envelope = parseProjected(result.response.body, listEnvelopeSchema, ["results"], "project studies");
      const pageStudies = envelope.results.map((raw) => parseStudyShort(raw, "project study"));
      pageStudies.forEach((study) => studies.set(study.id, study));
      if (pageStudies.length < this.options.pageSize) {
        completed = true;
        break;
      }
    }
    if (!completed) throw schemaDrift("Prolific project study pagination exceeded its safety limit.");
    return { data: [...studies.values()], evidence };
  }

  async reconcileStudyByIdentity(localStudyId: string): Promise<ReconciledStudy> {
    const metadata = z.uuid().parse(localStudyId);
    const internalName = `surveyor-demo:${metadata}`;
    const listed = await this.listProjectStudies();
    const matches = listed.data.filter((study) => study.internal_name === internalName);
    if (matches.length === 0) return { kind: "absent", evidence: listed.evidence };
    if (matches.length > 1) {
      throw new AppError("PROVIDER_AMBIGUOUS", "More than one Prolific draft matches this launch.", {
        status: 409,
        retryable: false,
        details: { matchCount: matches.length },
      });
    }
    const match = matches[0];
    if (!match) throw schemaDrift("Prolific reconciliation lost its unique match.");
    const fetched = await this.getStudy(match.id);
    if (
      fetched.data.internal_name !== internalName ||
      fetched.data.metadata !== metadata ||
      fetched.data.project !== this.options.projectId
    ) {
      throw new AppError("PROVIDER_AMBIGUOUS", "The matching Prolific study failed identity verification.", {
        status: 409,
        retryable: false,
      });
    }
    assertActionableProlificStudyStatus(fetched.data.status);
    return { kind: "found", study: fetched.data, evidence: [...listed.evidence, fetched.evidence] };
  }

  async getSubmission(submissionId: string): Promise<ProlificResult<ProlificSubmission>> {
    const id = prolificIdSchema.parse(submissionId);
    const result = await this.request(
      "submission.get",
      this.buildUrl(`/api/v1/submissions/${id}/`),
      { method: "GET" },
      undefined,
      true,
    );
    const submission = parseSubmission(result.response.body, "submission");
    if (submission.id !== id) throw schemaDrift("Prolific returned the wrong submission.");
    if (submission.status === "UNKNOWN") {
      throw schemaDrift("Prolific returned an unknown submission status.");
    }
    return { data: submission, evidence: result.evidence };
  }

  async validateSubmission(input: {
    submissionId: string;
    studyId: string;
    participantId: string;
    localResponseCompleted: boolean;
    pauseCutoff?: string;
  }): Promise<ProlificResult<SubmissionAccess>> {
    const ids = submissionValidationInputSchema.parse(input);
    const fetched = await this.getSubmission(ids.submissionId);
    const submission = fetched.data;
    if (submission.study_id !== ids.studyId || submission.participant !== ids.participantId) {
      throw new AppError("FORBIDDEN", "The Prolific submission identifiers do not match.", { status: 403 });
    }
    if (submission.status === "UNKNOWN") {
      throw schemaDrift("Prolific returned an unknown submission status.");
    }

    if (ids.pauseCutoff) {
      const cutoff = Date.parse(ids.pauseCutoff);
      const startedAt = Date.parse(submission.started_at);
      if (startedAt > cutoff) {
        throw new AppError("FORBIDDEN", "This submission started after collection was paused.", {
          status: 403,
        });
      }
    }

    let access: SubmissionAccess;
    if (
      ids.localResponseCompleted &&
      ["ACTIVE", "AWAITING REVIEW", "APPROVED"].includes(submission.status)
    ) {
      access = { kind: "completed_revisit", submission };
    } else if (!ids.localResponseCompleted && ["RESERVED", "ACTIVE"].includes(submission.status)) {
      access = { kind: "collect", submission };
    } else {
      access = { kind: "terminal", submission };
    }
    return { data: access, evidence: fetched.evidence };
  }

  async listSubmissions(studyId: string): Promise<ProlificPagedResult<ProlificSubmissionShort[]>> {
    const id = prolificIdSchema.parse(studyId);
    const submissions = new Map<string, ProlificSubmissionShort>();
    const evidence: ProlificEvidence[] = [];
    let completed = false;

    for (let page = 1; page <= this.options.maxPages; page += 1) {
      const result = await this.request(
        "submissions.list",
        this.buildUrl("/api/v1/submissions/", {
          study: id,
          page: String(page),
          page_size: String(this.options.pageSize),
          ordering: "started_at",
        }),
        { method: "GET" },
        undefined,
        true,
      );
      evidence.push(result.evidence);
      const envelope = parseProjected(result.response.body, listEnvelopeSchema, ["results"], "submissions");
      const pageSubmissions = envelope.results.map((raw) => parseSubmissionShort(raw, "submission list item"));
      if (pageSubmissions.some((submission) => submission.status === "UNKNOWN")) {
        throw schemaDrift("Prolific returned an unknown submission status while listing submissions.");
      }
      pageSubmissions.forEach((submission) => submissions.set(submission.id, submission));
      if (pageSubmissions.length < this.options.pageSize) {
        completed = true;
        break;
      }
    }
    if (!completed) throw schemaDrift("Prolific submission pagination exceeded its safety limit.");
    return { data: [...submissions.values()], evidence };
  }

  async listOutstandingSubmissions(
    studyId: string,
    pauseCutoff: string,
  ): Promise<ProlificPagedResult<ProlificSubmissionShort[]>> {
    const cutoff = Date.parse(z.iso.datetime().parse(pauseCutoff));
    const listed = await this.listSubmissions(studyId);
    return {
      data: listed.data.filter(
        (submission) =>
          (submission.status === "RESERVED" || submission.status === "ACTIVE") &&
          Date.parse(submission.started_at) <= cutoff,
      ),
      evidence: listed.evidence,
    };
  }

  async approveSubmission(submissionId: string): Promise<ProlificPagedResult<ProlificSubmission>> {
    const current = await this.getSubmission(submissionId);
    if (current.data.status === "APPROVED") {
      return { data: current.data, evidence: [current.evidence] };
    }
    if (current.data.status !== "AWAITING REVIEW") {
      throw new AppError("CONFLICT", "Only a completed Prolific submission can be approved.", {
        status: 409,
      });
    }
    const payload = { action: "APPROVE" as const };
    const result = await this.request(
      "submission.approve",
      this.buildUrl(`/api/v1/submissions/${current.data.id}/transition/`),
      { method: "POST" },
      payload,
      true,
    );
    const approved = parseSubmission(result.response.body, "approved submission");
    if (approved.id !== current.data.id || approved.status !== "APPROVED") {
      throw schemaDrift("Prolific did not confirm submission approval.");
    }
    return { data: approved, evidence: [current.evidence, result.evidence] };
  }

  private buildUrl(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(path, this.options.apiBaseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private safeFilterNextUrl(rawNext: string | undefined, currentUrl: URL, filterTag: string | undefined): URL | undefined {
    if (!rawNext) return undefined;
    let url: URL;
    try {
      url = new URL(rawNext, currentUrl);
    } catch (error) {
      throw schemaDrift("Prolific returned an invalid filter pagination link.", error);
    }
    if (
      url.origin !== this.options.apiBaseUrl.origin ||
      url.pathname !== "/api/v1/filters/" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw schemaDrift("Prolific returned an unsafe filter pagination link.");
    }
    const linkedWorkspace = url.searchParams.get("workspace_id");
    if (linkedWorkspace && linkedWorkspace !== this.options.workspaceId) {
      throw schemaDrift("Prolific filter pagination changed workspace context.");
    }
    const linkedDetailed = url.searchParams.get("detailed");
    if (linkedDetailed && linkedDetailed !== "true") {
      throw schemaDrift("Prolific filter pagination dropped detailed metadata.");
    }
    const linkedTag = url.searchParams.get("filter_tag");
    if (linkedTag && linkedTag !== filterTag) {
      throw schemaDrift("Prolific filter pagination changed its filter tag.");
    }
    url.searchParams.set("workspace_id", this.options.workspaceId);
    url.searchParams.set("detailed", "true");
    if (filterTag) url.searchParams.set("filter_tag", filterTag);
    return url;
  }

  private async request(
    operation: string,
    url: URL,
    init: Pick<RequestInit, "method">,
    body: unknown,
    safeToRetry: boolean,
  ): Promise<{ response: ProviderJsonResponse; evidence: ProlificEvidence }> {
    const method = init.method ?? "GET";
    const requestMetadata = {
      method,
      path: `${url.pathname}${url.search}`,
      ...(body === undefined ? {} : { body }),
    };
    let response: ProviderJsonResponse;
    try {
      response = await requestProviderJson({
        provider: "prolific",
        url: url.href,
        init: {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Token ${this.options.apiToken}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        maxRetries: safeToRetry ? this.options.maxRetries : 0,
        safeToRetry,
        fetchImpl: this.options.fetchImpl,
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
      });
    } catch (error) {
      if (!safeToRetry && isAmbiguousProviderFailure(error)) {
        throw new AppError("PROVIDER_AMBIGUOUS", "Prolific may have completed the external action.", {
          status: 503,
          retryable: true,
          cause: error,
          details: { operation, request: sanitizeProlificMetadata(requestMetadata) },
        });
      }
      throw error;
    }

    return {
      response,
      evidence: {
        operation,
        method,
        path: `${url.pathname}${url.search}`,
        httpStatus: response.status,
        request: sanitizeProlificMetadata(requestMetadata),
        response: sanitizeProlificMetadata(response.body),
        ...(response.requestId ? { requestId: response.requestId } : {}),
      },
    };
  }

  private requireStatus(
    response: ProviderJsonResponse,
    expected: readonly number[],
    operation: string,
    request?: unknown,
  ): void {
    if (expected.includes(response.status)) return;
    throw ambiguousProviderResult(
      operation,
      response,
      request,
      "Prolific returned an unexpected success status.",
    );
  }

  private parseStudyAfterMutation(
    response: ProviderJsonResponse,
    operation: string,
    request: unknown,
  ): ProlificStudy {
    try {
      return parseStudy(response.body, "study mutation");
    } catch (error) {
      if (error instanceof ProviderError && error.category === "schema_drift") {
        throw ambiguousProviderResult(
          operation,
          response,
          request,
          "Prolific accepted an action but returned an unrecognized study.",
          error,
        );
      }
      throw error;
    }
  }
}

const catalogFilterCommonShape = {
  filter_id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  question: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
};

const selectCatalogFilterSchema = z.strictObject({
  ...catalogFilterCommonShape,
  type: z.literal("select"),
  data_type: z.enum(["ChoiceID", "ParticipantID", "StudyID", "ParticipantGroupID"]),
  choices: z.record(z.string(), z.string().trim().min(1)),
});

const rangeCatalogFilterSchema = z.strictObject({
  ...catalogFilterCommonShape,
  type: z.literal("range"),
  data_type: z.enum(["date", "integer", "float"]),
  min: z.union([z.number(), z.string()]),
  max: z.union([z.number(), z.string()]),
});

const filterEnvelopeSchema = z.strictObject({
  results: z.array(z.unknown()),
  _links: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const eligibilitySchema = z.strictObject({ count: z.number().int().nonnegative() });
const costRequestSchema = z.strictObject({
  reward: z.number().int().positive(),
  total_available_places: participantCountSchema,
});
const costResponseSchema = z.strictObject({ total_cost: z.union([z.number(), z.string()]) });
const balanceSchema = z.strictObject({
  currency_code: z.string().trim().length(3),
  available_balance: z.union([z.number(), z.string()]),
});
const projectSchema = z.strictObject({ id: prolificIdSchema, workspace: z.string().trim().min(1) });
const listEnvelopeSchema = z.strictObject({ results: z.array(z.unknown()) });

const submissionValidationInputSchema = z.strictObject({
  submissionId: prolificIdSchema,
  studyId: prolificIdSchema,
  participantId: prolificIdSchema,
  localResponseCompleted: z.boolean(),
  pauseCutoff: z.iso.datetime().optional(),
});

const studyProjectionKeys = [
  "id",
  "status",
  "internal_name",
  "metadata",
  "project",
  "is_ready_to_publish",
  "name",
  "total_available_places",
  "reward",
] as const;
const studyShortProjectionKeys = ["id", "status", "internal_name", "is_ready_to_publish"] as const;
const submissionProjectionKeys = [
  "id",
  "participant",
  "study_id",
  "status",
  "started_at",
  "completed_at",
  "entered_code",
] as const;
const submissionShortProjectionKeys = [
  "id",
  "participant_id",
  "status",
  "started_at",
  "completed_at",
] as const;

function adaptCatalogFilter(input: unknown): NormalizedCatalogFilter {
  if (!isRecord(input)) throw schemaDrift("Prolific returned an invalid catalog filter.");
  if (input.type === "select") {
    const parsed = parseProjected(
      input,
      selectCatalogFilterSchema,
      ["filter_id", "title", "question", "category", "type", "data_type", "choices"],
      "select catalog filter",
    );
    return {
      id: parsed.filter_id,
      title: parsed.title,
      question: parsed.question ?? "",
      category: parsed.category ?? "",
      type: "select",
      choices: Object.entries(parsed.choices).map(([id, label]) => ({ id, label })),
      raw: sanitizeProlificMetadata({ data_type: parsed.data_type }),
    };
  }
  if (input.type === "range") {
    const parsed = parseProjected(
      input,
      rangeCatalogFilterSchema,
      ["filter_id", "title", "question", "category", "type", "data_type", "min", "max"],
      "range catalog filter",
    );
    const numericMin = parseNumericCatalogBound(parsed.min, parsed.data_type);
    const numericMax = parseNumericCatalogBound(parsed.max, parsed.data_type);
    return {
      id: parsed.filter_id,
      title: parsed.title,
      question: parsed.question ?? "",
      category: parsed.category ?? "",
      type: "range",
      ...(numericMin === undefined ? {} : { min: numericMin }),
      ...(numericMax === undefined ? {} : { max: numericMax }),
      raw: sanitizeProlificMetadata({ data_type: parsed.data_type, min: parsed.min, max: parsed.max }),
    };
  }
  throw schemaDrift("Prolific returned an unsupported filter type.");
}

function parseNumericCatalogBound(value: number | string, dataType: "date" | "integer" | "float"): number | undefined {
  if (dataType === "date") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw schemaDrift("Prolific returned an invalid numeric filter bound.");
  if (dataType === "integer" && !Number.isInteger(numeric)) {
    throw schemaDrift("Prolific returned a non-integer bound for an integer filter.");
  }
  return numeric;
}

function deduplicateCatalog(filters: readonly NormalizedCatalogFilter[]): NormalizedCatalogFilter[] {
  const byId = new Map<string, NormalizedCatalogFilter>();
  for (const filter of filters) {
    const existing = byId.get(filter.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(filter)) {
      throw schemaDrift("Prolific returned conflicting definitions for one filter.");
    }
    byId.set(filter.id, filter);
  }
  return [...byId.values()];
}

function extractNextLink(links: Record<string, unknown> | undefined): string | undefined {
  const next = links?.next;
  if (next === undefined || next === null || next === "") return undefined;
  if (typeof next === "string") return next;
  if (isRecord(next)) {
    if (next.href === null || next.href === "") return undefined;
    if (typeof next.href === "string") return next.href;
    if (next.url === null || next.url === "") return undefined;
    if (typeof next.url === "string") return next.url;
  }
  throw schemaDrift("Prolific returned an unrecognized filter pagination link.");
}

function parseStudy(input: unknown, label: string): ProlificStudy {
  return parseProjected(input, prolificStudySchema, studyProjectionKeys, label);
}

function parseStudyShort(input: unknown, label: string): ProlificStudyShort {
  return parseProjected(input, prolificStudyShortSchema, studyShortProjectionKeys, label);
}

function parseSubmission(input: unknown, label: string): ProlificSubmission {
  return parseProjected(input, prolificSubmissionSchema, submissionProjectionKeys, label);
}

function parseSubmissionShort(input: unknown, label: string): ProlificSubmissionShort {
  return parseProjected(input, prolificSubmissionShortSchema, submissionShortProjectionKeys, label);
}

function parseProjected<T>(
  input: unknown,
  schema: ZodType<T>,
  keys: readonly string[],
  label: string,
): T {
  if (!isRecord(input)) throw schemaDrift(`Prolific returned an invalid ${label}.`);
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) projected[key] = input[key];
  }
  const parsed = schema.safeParse(projected);
  if (!parsed.success) {
    throw schemaDrift(`Prolific returned an unrecognized ${label}.`, parsed.error);
  }
  return parsed.data;
}

function schemaDrift(message: string, cause?: unknown): ProviderError {
  return new ProviderError({
    provider: "prolific",
    category: "schema_drift",
    message,
    dispatched: true,
    retryable: false,
    cause,
  });
}

function isAmbiguousProviderFailure(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.dispatched &&
    (error.category === "network" ||
      error.category === "timeout" ||
      error.retryable ||
      error.httpStatus === 429 ||
      (error.httpStatus !== undefined && error.httpStatus >= 500))
  );
}

function ambiguousProviderResult(
  operation: string,
  response: ProviderJsonResponse,
  request: unknown,
  message: string,
  cause?: unknown,
): AppError {
  return new AppError("PROVIDER_AMBIGUOUS", message, {
    status: 503,
    retryable: true,
    cause,
    details: {
      operation,
      httpStatus: response.status,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      request: sanitizeProlificMetadata(request),
      response: sanitizeProlificMetadata(response.body),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

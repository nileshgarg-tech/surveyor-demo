import { AppError } from "@/lib/errors";

export type ProviderFailureCategory =
  | "network"
  | "timeout"
  | "http"
  | "model_not_found"
  | "refusal"
  | "invalid_output"
  | "schema_drift";

export class ProviderError extends AppError {
  readonly provider: "gemini" | "openai" | "prolific";
  readonly category: ProviderFailureCategory;
  readonly httpStatus?: number;
  readonly machineCode?: string;
  readonly dispatched: boolean;
  readonly fallbackEligible: boolean;

  constructor(options: {
    provider: ProviderError["provider"];
    category: ProviderFailureCategory;
    message: string;
    httpStatus?: number;
    machineCode?: string;
    dispatched?: boolean;
    retryable?: boolean;
    fallbackEligible?: boolean;
    cause?: unknown;
  }) {
    super(
      options.category === "schema_drift" ? "SCHEMA_DRIFT" : "PROVIDER_REJECTED",
      options.message,
      {
        status: options.httpStatus && options.httpStatus >= 400 ? 502 : 503,
        retryable: options.retryable ?? false,
        cause: options.cause,
      },
    );
    this.name = "ProviderError";
    this.provider = options.provider;
    this.category = options.category;
    this.dispatched = options.dispatched ?? false;
    this.fallbackEligible = options.fallbackEligible ?? false;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.machineCode !== undefined) this.machineCode = options.machineCode;
  }
}

type ProviderRequestOptions = {
  provider: ProviderError["provider"];
  url: string;
  init: RequestInit;
  maxRetries: number;
  timeoutMs?: number;
  safeToRetry?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

export type ProviderJsonResponse = {
  body: unknown;
  status: number;
  requestId?: string;
};

export async function requestProviderJson(options: ProviderRequestOptions): Promise<ProviderJsonResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const safeToRetry = options.safeToRetry ?? true;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(options.url, { ...options.init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      const timedOut = controller.signal.aborted;
      const retryable = safeToRetry && attempt < options.maxRetries;
      if (retryable) {
        await sleep(backoffMilliseconds(attempt, undefined, random));
        attempt += 1;
        continue;
      }
      throw new ProviderError({
        provider: options.provider,
        category: timedOut ? "timeout" : "network",
        message: `${providerLabel(options.provider)} is temporarily unavailable.`,
        dispatched: true,
        retryable: true,
        fallbackEligible: options.provider === "gemini",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }

    const body = await parseResponseBody(response);
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    if (response.ok) return requestId ? { body, status: response.status, requestId } : { body, status: response.status };

    const machineCode = extractMachineCode(body);
    const transient =
      response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (transient && safeToRetry && attempt < options.maxRetries) {
      await sleep(backoffMilliseconds(attempt, response.headers.get("retry-after"), random));
      attempt += 1;
      continue;
    }
    throw new ProviderError({
      provider: options.provider,
      category: response.status === 404 && machineCode === "model_not_found" ? "model_not_found" : "http",
      message: providerHttpMessage(options.provider, response.status),
      httpStatus: response.status,
      ...(machineCode ? { machineCode } : {}),
      dispatched: true,
      retryable: transient,
      fallbackEligible:
        options.provider === "gemini" &&
        (transient || machineCode === "model_not_found" || isMachineReadableRefusal(machineCode)),
    });
  }
}

export function isMachineReadableRefusal(code: string | undefined): boolean {
  return new Set([
    "safety",
    "recitation",
    "language",
    "prohibited_content",
    "spii",
    "blocklist",
    "content_blocked",
  ]).has(code ?? "");
}

function extractMachineCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const code = (nested as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  if (typeof record.code === "string") return record.code;
  return undefined;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text();
  return text.slice(0, 2_000);
}

function backoffMilliseconds(attempt: number, retryAfter: string | null | undefined, random: () => number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(random() * 250), 8_000);
}

function providerLabel(provider: ProviderError["provider"]): string {
  return provider === "prolific" ? "Prolific" : provider === "gemini" ? "Gemini" : "OpenAI";
}

function providerHttpMessage(provider: ProviderError["provider"], status: number): string {
  const label = providerLabel(provider);
  if (status === 401) return `${label} credentials were rejected.`;
  if (status === 403) return `${label} did not authorize this action.`;
  if (status === 429) return `${label} is busy. Please retry shortly.`;
  if (status >= 500) return `${label} is temporarily unavailable.`;
  return `${label} rejected the request.`;
}

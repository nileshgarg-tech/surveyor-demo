import { createHash } from "node:crypto";
import { AppError } from "@/lib/errors";
import { databaseError } from "@/lib/data";
import { sanitizeProlificMetadata, type ProlificEvidence } from "@/lib/providers/prolific";
import { getServiceSupabase } from "@/lib/supabase/server";

export type ProviderEventResultStatus = "succeeded" | "definitive_failure" | "ambiguous";
export type ProviderEffectEvidence =
  | "unknown"
  | "request_not_dispatched"
  | "definitive_no_create"
  | "draft_exists"
  | "published_or_spend_possible"
  | "external_deleted"
  | "non_recruiting";

export async function claimProviderOperation(options: {
  provider: "prolific" | "gemini" | "openai";
  operation: string;
  localOperationKey: string;
  studyId?: string;
  requestFingerprint?: string;
  sanitizedRequest?: unknown;
}): Promise<{ eventId: string; applied: boolean; status: string }> {
  const { data, error } = await getServiceSupabase().rpc("claim_provider_operation", {
    p_provider: options.provider,
    p_operation: options.operation,
    p_local_operation_key: options.localOperationKey,
    p_study_id: options.studyId ?? null,
    p_request_fingerprint: options.requestFingerprint ?? null,
    p_sanitized_request: sanitizeProlificMetadata(options.sanitizedRequest ?? {}),
  });
  if (error) throw databaseError("Provider operation could not be reserved.", error);
  const row = asRecord(data);
  return { eventId: String(row.eventId), applied: row.applied === true, status: String(row.status) };
}

export async function markProviderDispatched(eventId: string): Promise<void> {
  const { error } = await getServiceSupabase().rpc("mark_provider_operation_dispatched", {
    p_event_id: eventId,
  });
  if (error) throw databaseError("Provider dispatch evidence could not be saved.", error);
}

export async function recordProviderResult(options: {
  eventId: string;
  status: ProviderEventResultStatus;
  effect: ProviderEffectEvidence;
  response?: unknown;
  requestId?: string | undefined;
  externalResourceId?: string | undefined;
  externalStatus?: string | undefined;
  observedAmountCents?: number | undefined;
  observedCurrencyCode?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}): Promise<void> {
  const { error } = await getServiceSupabase().rpc("record_provider_operation_result", {
    p_event_id: options.eventId,
    p_status: options.status,
    p_effect_evidence: options.effect,
    p_sanitized_response: options.response === undefined ? null : sanitizeProlificMetadata(options.response),
    p_provider_request_id: options.requestId ?? null,
    p_external_resource_id: options.externalResourceId ?? null,
    p_external_status: options.externalStatus ?? null,
    p_observed_amount_cents: options.observedAmountCents ?? null,
    p_observed_currency_code: options.observedCurrencyCode ?? null,
    p_error_code: options.errorCode ?? null,
    p_error_message: options.errorMessage ? safeError(options.errorMessage) : null,
  });
  if (error) throw databaseError("Provider result evidence could not be saved.", error);
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function evidenceRequestId(evidence: ProlificEvidence | ProlificEvidence[]): string | undefined {
  const values = Array.isArray(evidence) ? evidence : [evidence];
  return values.find((item) => item.requestId)?.requestId;
}

export function safeError(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, "[URL]").replace(/[A-Fa-f0-9]{24}/g, "[PROVIDER_ID]").slice(0, 500);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("SCHEMA_DRIFT", "Database RPC returned an unexpected result.", { status: 500 });
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

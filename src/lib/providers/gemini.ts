import { z, type ZodType } from "zod";
import { getEnv, requireLiveConfig } from "@/lib/env";
import { ProviderError, requestProviderJson } from "@/lib/providers/http";
import { readinessJsonSchema, type JsonSchema } from "@/lib/providers/json-schemas";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1/interactions";

const geminiErrorSchema = z
  .object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough() })
  .passthrough();

const geminiResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    model: z.string(),
    steps: z.array(z.unknown()),
  })
  .passthrough();

export type StructuredGeneration<T> = {
  data: T;
  interactionId?: string;
  provider: "gemini" | "openai";
  model: string;
};

export type GeminiGenerateOptions<T> = {
  schemaName: string;
  schema: JsonSchema;
  validator: ZodType<T>;
  systemInstruction: string;
  input: string;
  previousInteractionId?: string;
  store?: boolean;
  fetchImpl?: typeof fetch;
};

let validationPromise: Promise<void> | undefined;
let validatedModel: string | undefined;

export async function validateGeminiModel(fetchImpl?: typeof fetch): Promise<void> {
  const env = requireLiveConfig(["GEMINI_API_KEY"]);
  if (validatedModel === env.GEMINI_MODEL && validationPromise) return validationPromise;
  validatedModel = env.GEMINI_MODEL;
  validationPromise = (async () => {
    const result = await callGemini(
      {
        schemaName: "readiness",
        schema: readinessJsonSchema,
        validator: z.object({ ok: z.literal(true) }).strict(),
        systemInstruction: "Set ok to true. Return only the schema-constrained result.",
        input: "Return readiness confirmation.",
        store: false,
        ...(fetchImpl ? { fetchImpl } : {}),
      },
      false,
    );
    if (!result.data.ok) throw new Error("unreachable");
  })();
  try {
    await validationPromise;
  } catch (error) {
    validationPromise = undefined;
    validatedModel = undefined;
    throw error;
  }
}

export async function generateWithGemini<T>(
  options: GeminiGenerateOptions<T>,
): Promise<StructuredGeneration<T>> {
  await validateGeminiModel(options.fetchImpl);
  return callGemini(options, true);
}

async function callGemini<T>(
  options: GeminiGenerateOptions<T>,
  allowValidation: boolean,
): Promise<StructuredGeneration<T>> {
  const env = requireLiveConfig(["GEMINI_API_KEY"]);
  const request: Record<string, unknown> = {
    model: env.GEMINI_MODEL,
    input: options.input,
    store: options.store ?? true,
    system_instruction: options.systemInstruction,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: options.schema,
    },
  };
  if (options.previousInteractionId) request.previous_interaction_id = options.previousInteractionId;

  const response = await requestProviderJson({
    provider: "gemini",
    url: GEMINI_INTERACTIONS_URL,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(request),
    },
    maxRetries: getEnv().MAX_PROVIDER_RETRIES,
    safeToRetry: true,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const parsedResponse = geminiResponseSchema.safeParse(response.body);
  if (!parsedResponse.success) {
    const providerError = geminiErrorSchema.safeParse(response.body);
    throw new ProviderError({
      provider: "gemini",
      category: "schema_drift",
      message: "Gemini returned an unrecognized response.",
      ...(providerError.success && providerError.data.error.code ? { machineCode: providerError.data.error.code } : {}),
      dispatched: true,
      fallbackEligible: allowValidation,
    });
  }
  if (parsedResponse.data.status !== "completed" || parsedResponse.data.model !== env.GEMINI_MODEL) {
    throw new ProviderError({
      provider: "gemini",
      category: "schema_drift",
      message: "Gemini did not complete with the configured model.",
      machineCode: parsedResponse.data.status,
      dispatched: true,
      fallbackEligible: false,
    });
  }

  const text = extractGeminiText(parsedResponse.data.steps);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ProviderError({
      provider: "gemini",
      category: "invalid_output",
      message: "Gemini returned invalid structured output.",
      dispatched: true,
      fallbackEligible: allowValidation,
      cause: error,
    });
  }
  const validated = options.validator.safeParse(json);
  if (!validated.success) {
    throw new ProviderError({
      provider: "gemini",
      category: "invalid_output",
      message: "Gemini output failed local validation.",
      dispatched: true,
      fallbackEligible: allowValidation,
      cause: validated.error,
    });
  }
  return {
    data: validated.data,
    interactionId: parsedResponse.data.id,
    provider: "gemini",
    model: env.GEMINI_MODEL,
  };
}

function extractGeminiText(steps: unknown[]): string {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || typeof step !== "object") continue;
    const record = step as Record<string, unknown>;
    if (record.type !== "model_output" || !Array.isArray(record.content)) continue;
    for (const item of record.content) {
      if (!item || typeof item !== "object") continue;
      const content = item as Record<string, unknown>;
      if (content.type === "text" && typeof content.text === "string") return content.text;
    }
  }
  throw new ProviderError({
    provider: "gemini",
    category: "invalid_output",
    message: "Gemini returned no structured text.",
    dispatched: true,
    fallbackEligible: true,
  });
}

export function resetGeminiValidationForTests() {
  validationPromise = undefined;
  validatedModel = undefined;
}

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
    id: z.string().min(1).optional(),
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
  enableGrounding?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
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
    ...(options.enableGrounding ? { tools: [{ type: "google_search" }] } : {}),
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
    maxRetries: options.maxRetries ?? getEnv().MAX_PROVIDER_RETRIES,
    safeToRetry: true,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
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
    if (options.schemaName === "surveyor_intake") {
      json = sanitizeIntakeJson(json);
    }
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
    ...(parsedResponse.data.id ? { interactionId: parsedResponse.data.id } : {}),
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

function sanitizeIntakeJson(json: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const obj = { ...(json as Record<string, unknown>) };
  if (obj.kind === "ready" && obj.survey && typeof obj.survey === "object") {
    const survey = { ...(obj.survey as Record<string, unknown>) };
    if (Array.isArray(survey.questions)) {
      const sanitizedQuestions: Record<string, unknown>[] = [];
      for (const q of survey.questions) {
        if (!q || typeof q !== "object") continue;
        const item = { ...(q as Record<string, unknown>) };

        // Normalize ref / id
        if (!item.ref && typeof item.id === "string") {
          item.ref = item.id;
        }
        let refStr = typeof item.ref === "string" ? item.ref.replace(/[^a-z0-9_]/gi, "_").toLowerCase() : "";
        if (!refStr || !/^[a-z]/.test(refStr)) {
          refStr = `q_${refStr || (sanitizedQuestions.length + 1)}`;
        }
        item.ref = refStr.slice(0, 32);

        // Normalize title / text
        if (!item.title && typeof item.text === "string") item.title = item.text;

        // Normalize choices / options
        if (!item.choices && Array.isArray(item.options)) {
          item.choices = (item.options as unknown[]).map(String);
        }
        item.required = true;

        // Normalize question types
        if (item.type === "single_choice" || item.type === "select" || item.type === "radio") {
          item.type = "multiple_choice";
        }

        // Convert matrix questions into individual multiple_choice questions
        if (item.type === "matrix" && Array.isArray(item.rows) && Array.isArray(item.columns)) {
          const rows = (item.rows as unknown[]).map(String);
          const cols = (item.columns as unknown[]).map(String);
          const baseRef = typeof item.ref === "string" ? item.ref : "q_matrix";
          rows.slice(0, 4).forEach((rowTitle, idx) => {
            sanitizedQuestions.push({
              ref: `${baseRef}_${idx + 1}`.slice(0, 32),
              title: `${typeof item.title === "string" ? item.title : "Opinion"}: ${rowTitle}`,
              type: "multiple_choice",
              required: true,
              choices: cols.slice(0, 7),
            });
          });
          continue;
        }

        sanitizedQuestions.push(item);
      }
      survey.questions = sanitizedQuestions.slice(0, 6);
    }
    obj.survey = survey;
  }
  return obj;
}

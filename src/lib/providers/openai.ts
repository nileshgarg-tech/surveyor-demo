import { z, type ZodType } from "zod";
import { getEnv, requireLiveConfig } from "@/lib/env";
import { ProviderError, requestProviderJson } from "@/lib/providers/http";
import type { JsonSchema } from "@/lib/providers/json-schemas";
import type { StructuredGeneration } from "@/lib/providers/gemini";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const responseSchema = z
  .object({
    status: z.string(),
    model: z.string(),
    output: z.array(z.unknown()),
  })
  .passthrough();

export async function generateWithOpenAI<T>(options: {
  schemaName: string;
  schema: JsonSchema;
  validator: ZodType<T>;
  systemInstruction: string;
  input: string;
  fetchImpl?: typeof fetch;
}): Promise<StructuredGeneration<T>> {
  const env = requireLiveConfig(["OPENAI_API_KEY"]);
  const model = getEnv().OPENAI_FALLBACK_MODEL ?? "gpt-4o-mini";
  const providerOutputSchema = openAIResponseSchema(options.schema);
  let input = options.input;
  let lastValidationError: z.ZodError | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestProviderJson({
      provider: "openai",
      url: OPENAI_RESPONSES_URL,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: model,
          instructions: options.systemInstruction,
          input,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: options.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
              strict: true,
              schema: providerOutputSchema,
            },
          },
        }),
      },
      maxRetries: getEnv().MAX_PROVIDER_RETRIES,
      safeToRetry: true,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const parsed = responseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.status !== "completed") {
      throw new ProviderError({
        provider: "openai",
        category: "schema_drift",
        message: "OpenAI fallback returned an unrecognized response.",
        dispatched: true,
      });
    }
    const text = extractOpenAIText(parsed.data.output);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ProviderError({
        provider: "openai",
        category: "invalid_output",
        message: "OpenAI fallback returned invalid structured output.",
        dispatched: true,
        cause: error,
      });
    }
    const unwrapped =
      json && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>).result
        : undefined;
    const validated = options.validator.safeParse(unwrapped);
    if (validated.success) {
      return {
        data: validated.data,
        provider: "openai",
        model: model,
      };
    }

    lastValidationError = validated.error;
    input = `${options.input}\n\nADDITIONAL_DETERMINISTIC_VALIDATION\nThe prior schema-constrained result failed these local checks. Return a fresh, complete result that fixes every issue:\n${formatValidationIssues(validated.error)}`;
  }

  throw new ProviderError({
    provider: "openai",
    category: "invalid_output",
    message: "OpenAI fallback output failed local validation after one repair attempt.",
    dispatched: true,
    cause: lastValidationError,
  });
}

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "result"}: ${issue.message}`)
    .join("\n");
}

function openAIResponseSchema(schema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { result: normalizeOpenAISchema(schema) },
    required: ["result"],
    additionalProperties: false,
  };
}

function normalizeOpenAISchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenAISchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    normalized[key === "oneOf" ? "anyOf" : key] = normalizeOpenAISchema(item);
  }
  return normalized;
}

function extractOpenAIText(output: unknown[]): string {
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || !Array.isArray(record.content)) continue;
    for (const contentItem of record.content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const content = contentItem as Record<string, unknown>;
      if (content.type === "refusal") {
        throw new ProviderError({
          provider: "openai",
          category: "refusal",
          message: "The fallback model could not generate this study.",
          dispatched: true,
        });
      }
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new ProviderError({
    provider: "openai",
    category: "invalid_output",
    message: "OpenAI fallback returned no structured text.",
    dispatched: true,
  });
}

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
  const env = requireLiveConfig(["OPENAI_API_KEY", "OPENAI_FALLBACK_MODEL"]);
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
        model: env.OPENAI_FALLBACK_MODEL,
        instructions: options.systemInstruction,
        input: options.input,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: options.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
            strict: true,
            schema: options.schema,
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
  const validated = options.validator.safeParse(json);
  if (!validated.success) {
    throw new ProviderError({
      provider: "openai",
      category: "invalid_output",
      message: "OpenAI fallback output failed local validation.",
      dispatched: true,
      cause: validated.error,
    });
  }
  return {
    data: validated.data,
    provider: "openai",
    model: env.OPENAI_FALLBACK_MODEL,
  };
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

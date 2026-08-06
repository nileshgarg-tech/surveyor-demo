import type { ZodType } from "zod";
import { getEnv } from "@/lib/env";
import { generateWithGemini, type StructuredGeneration } from "@/lib/providers/gemini";
import { generateWithOpenAI } from "@/lib/providers/openai";
import { ProviderError } from "@/lib/providers/http";
import type { JsonSchema } from "@/lib/providers/json-schemas";

export async function generateStructured<T>(options: {
  schemaName: string;
  schema: JsonSchema;
  validator: ZodType<T>;
  systemInstruction: string;
  input: string;
  previousInteractionId?: string;
  store?: boolean;
  enableGrounding?: boolean;
  geminiFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<StructuredGeneration<T>> {
  try {
    return await generateWithGemini({
      schemaName: options.schemaName,
      schema: options.schema,
      validator: options.validator,
      systemInstruction: options.systemInstruction,
      input: options.input,
      ...(options.previousInteractionId ? { previousInteractionId: options.previousInteractionId } : {}),
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.enableGrounding !== undefined ? { enableGrounding: options.enableGrounding } : {}),
      ...(options.geminiFetch ? { fetchImpl: options.geminiFetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
  } catch (error) {
    const env = getEnv();
    const fallbackConfigured = Boolean(env.OPENAI_API_KEY);
    if (!(error instanceof ProviderError) || !error.fallbackEligible || !fallbackConfigured) throw error;
    return generateWithOpenAI({
      schemaName: options.schemaName,
      schema: options.schema,
      validator: options.validator,
      systemInstruction: options.systemInstruction,
      input: options.input,
      ...(options.openaiFetch ? { fetchImpl: options.openaiFetch } : {}),
    });
  }
}

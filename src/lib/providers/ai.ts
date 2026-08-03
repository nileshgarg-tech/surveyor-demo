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
  geminiFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
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
      ...(options.geminiFetch ? { fetchImpl: options.geminiFetch } : {}),
    });
  } catch (error) {
    const env = getEnv();
    const fallbackConfigured = Boolean(env.OPENAI_API_KEY && env.OPENAI_FALLBACK_MODEL);
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

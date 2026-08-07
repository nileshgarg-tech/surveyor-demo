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
  /** Which provider to try first. Defaults to "gemini". "openai" only takes effect when OpenAI is configured. */
  primary?: "gemini" | "openai";
  openaiTimeoutMs?: number;
  openaiMaxRetries?: number;
}): Promise<StructuredGeneration<T>> {
  const env = getEnv();
  const openaiConfigured = Boolean(env.OPENAI_API_KEY);

  const callGemini = () =>
    generateWithGemini({
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

  const callOpenAi = () =>
    generateWithOpenAI({
      schemaName: options.schemaName,
      schema: options.schema,
      validator: options.validator,
      systemInstruction: options.systemInstruction,
      input: options.input,
      ...(options.openaiFetch ? { fetchImpl: options.openaiFetch } : {}),
      ...(options.openaiTimeoutMs !== undefined ? { timeoutMs: options.openaiTimeoutMs } : {}),
      ...(options.openaiMaxRetries !== undefined ? { maxRetries: options.openaiMaxRetries } : {}),
    });

  if (options.primary === "openai" && openaiConfigured) {
    try {
      return await callOpenAi();
    } catch {
      return callGemini();
    }
  }

  try {
    return await callGemini();
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.fallbackEligible || !openaiConfigured) throw error;
    return callOpenAi();
  }
}

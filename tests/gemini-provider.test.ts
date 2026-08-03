import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "@/lib/providers/ai";
import {
  generateWithGemini,
  resetGeminiValidationForTests,
} from "@/lib/providers/gemini";
import { ProviderError, requestProviderJson } from "@/lib/providers/http";
import type { JsonSchema } from "@/lib/providers/json-schemas";
import { resetEnvForTests } from "@/lib/env";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1/interactions";
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_KEY = "gemini-test-key";
const OPENAI_MODEL = "gpt-test-fallback";

const resultJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    value: { type: "string" },
  },
  required: ["value"],
  additionalProperties: false,
};

const resultValidator = z.object({ value: z.string() }).strict();

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function geminiResponse(data: unknown, id: string | null = "int_test"): Response {
  return jsonResponse({
    ...(id ? { id } : {}),
    status: "completed",
    object: "interaction",
    model: GEMINI_MODEL,
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(data) }],
      },
    ],
  });
}

function openAIResponse(data: unknown): Response {
  return jsonResponse({
    status: "completed",
    model: OPENAI_MODEL,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(data) }],
      },
    ],
  });
}

function sequenceFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  return fetchMock;
}

function generationOptions(fetchImpl: typeof fetch, input = "Build a survey") {
  return {
    schemaName: "test_result",
    schema: resultJsonSchema,
    validator: resultValidator,
    systemInstruction: "Return the requested result.",
    input,
    fetchImpl,
  };
}

function structuredOptions(geminiFetch: typeof fetch, openaiFetch: typeof fetch) {
  return {
    schemaName: "test_result",
    schema: resultJsonSchema,
    validator: resultValidator,
    systemInstruction: "Return the requested result.",
    input: "Build a survey",
    geminiFetch,
    openaiFetch,
  };
}

function enableOpenAIFallback() {
  vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
  vi.stubEnv("OPENAI_FALLBACK_MODEL", OPENAI_MODEL);
  resetEnvForTests();
}

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchMock.mock.calls.at(index);
  expect(call, `expected fetch call ${index}`).toBeDefined();
  const init = call?.[1];
  expect(init?.body).toBeTypeOf("string");
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY);
  vi.stubEnv("GEMINI_MODEL", GEMINI_MODEL);
  vi.stubEnv("MAX_PROVIDER_RETRIES", "0");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_FALLBACK_MODEL", "");
  resetEnvForTests();
  resetGeminiValidationForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvForTests();
  resetGeminiValidationForTests();
});

describe("Gemini Interactions contract", () => {
  it("uses the exact stable v1 request, configured model, and structured output shape", async () => {
    const fetchMock = sequenceFetch(
      geminiResponse({ ok: true }, null),
      geminiResponse({ value: "parsed" }, "int_generation"),
    );

    const result = await generateWithGemini({
      ...generationOptions(fetchMock),
      previousInteractionId: "int_server_persisted",
    });

    expect(result).toEqual({
      data: { value: "parsed" },
      interactionId: "int_generation",
      provider: "gemini",
      model: GEMINI_MODEL,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(GEMINI_URL);
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_KEY,
        },
      });
    }

    const diagnostic = requestBody(fetchMock, 0);
    expect(diagnostic).toEqual({
      model: GEMINI_MODEL,
      input: "Return readiness confirmation.",
      store: false,
      system_instruction: "Set ok to true. Return only the schema-constrained result.",
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean", const: true } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    });

    const generation = requestBody(fetchMock, 1);
    expect(generation).toEqual({
      model: GEMINI_MODEL,
      input: "Build a survey",
      store: true,
      system_instruction: "Return the requested result.",
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: resultJsonSchema,
      },
      previous_interaction_id: "int_server_persisted",
    });
  });

  it("omits deprecated sampling, candidate, legacy response, and model-prefill fields", async () => {
    const fetchMock = sequenceFetch(
      geminiResponse({ ok: true }, "int_readiness"),
      geminiResponse({ value: "safe" }, "int_generation"),
    );

    await generateWithGemini(generationOptions(fetchMock));

    const forbiddenKeys = [
      "temperature",
      "top_p",
      "top_k",
      "candidate_count",
      "response_mime_type",
      "thinking_budget",
      "contents",
    ];
    for (const index of [0, 1]) {
      const body = requestBody(fetchMock, index);
      const serialized = JSON.stringify(body);
      for (const key of forbiddenKeys) expect(serialized).not.toContain(`"${key}"`);
      expect(serialized).not.toContain('"role":"model"');
      expect(body.input).toBeTypeOf("string");
    }
  });

  it("parses JSON and validates the structured result locally", async () => {
    const fetchMock = sequenceFetch(
      geminiResponse({ ok: true }, "int_readiness"),
      geminiResponse({ value: 42 }, "int_generation"),
    );

    await expect(generateWithGemini(generationOptions(fetchMock))).rejects.toMatchObject({
      name: "ProviderError",
      category: "invalid_output",
      fallbackEligible: true,
    });
  });

  it("caches one successful readiness diagnostic for repeated calls on the same model", async () => {
    const fetchMock = sequenceFetch(
      geminiResponse({ ok: true }, "int_readiness"),
      geminiResponse({ value: "first" }, "int_first"),
      geminiResponse({ value: "second" }, "int_second"),
    );

    await generateWithGemini(generationOptions(fetchMock, "First"));
    await generateWithGemini(generationOptions(fetchMock, "Second"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const inputs = fetchMock.mock.calls.map((_, index) => requestBody(fetchMock, index).input);
    expect(inputs).toEqual(["Return readiness confirmation.", "First", "Second"]);
  });
});

describe("provider retry contract", () => {
  it.each([408, 429, 500, 503, 599])("retries transient HTTP %i responses", async (status) => {
    const fetchMock = sequenceFetch(
      jsonResponse({ error: { code: "temporary", message: "retry" } }, status, {
        "retry-after": "0",
      }),
      jsonResponse({ ok: true }),
    );
    const sleep = vi.fn(async () => undefined);

    const result = await requestProviderJson({
      provider: "gemini",
      url: GEMINI_URL,
      init: { method: "POST" },
      maxRetries: 1,
      fetchImpl: fetchMock,
      sleep,
      random: () => 0,
    });

    expect(result).toMatchObject({ body: { ok: true }, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 499])("does not retry non-transient HTTP %i responses", async (status) => {
    const fetchMock = sequenceFetch(
      jsonResponse({ error: { code: "invalid_request", message: "do not retry" } }, status),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestProviderJson({
        provider: "gemini",
        url: GEMINI_URL,
        init: { method: "POST" },
        maxRetries: 3,
        fetchImpl: fetchMock,
        sleep,
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      category: "http",
      fallbackEligible: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a network failure and marks exhausted transient failures fallback-eligible", async () => {
    const recoveringFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestProviderJson({
        provider: "gemini",
        url: GEMINI_URL,
        init: { method: "POST" },
        maxRetries: 1,
        fetchImpl: recoveringFetch,
        sleep,
        random: () => 0,
      }),
    ).resolves.toMatchObject({ body: { ok: true } });
    expect(recoveringFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);

    const exhaustedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code: "service_unavailable" } }, 503));
    await expect(
      requestProviderJson({
        provider: "gemini",
        url: GEMINI_URL,
        init: { method: "POST" },
        maxRetries: 1,
        fetchImpl: exhaustedFetch,
        sleep,
        random: () => 0,
      }),
    ).rejects.toMatchObject({
      category: "http",
      httpStatus: 503,
      retryable: true,
      fallbackEligible: true,
    });
    expect(exhaustedFetch).toHaveBeenCalledTimes(2);
  });

  it("makes only a machine-readable model_not_found error fallback-eligible", async () => {
    const codedFetch = sequenceFetch(
      jsonResponse({ error: { code: "model_not_found", message: "missing" } }, 404),
    );
    await expect(
      requestProviderJson({
        provider: "gemini",
        url: GEMINI_URL,
        init: { method: "POST" },
        maxRetries: 0,
        fetchImpl: codedFetch,
      }),
    ).rejects.toMatchObject({
      category: "model_not_found",
      machineCode: "model_not_found",
      fallbackEligible: true,
    });

    const proseOnlyFetch = sequenceFetch(
      jsonResponse({ error: { message: "The model was not found" } }, 404),
    );
    await expect(
      requestProviderJson({
        provider: "gemini",
        url: GEMINI_URL,
        init: { method: "POST" },
        maxRetries: 0,
        fetchImpl: proseOnlyFetch,
      }),
    ).rejects.toMatchObject({
      category: "http",
      fallbackEligible: false,
    });
  });
});

describe("fallback routing contract", () => {
  it.each([
    [404, "model_not_found"],
    [400, "safety"],
  ])("falls back for eligible machine code %s", async (status, machineCode) => {
    enableOpenAIFallback();
    const geminiFetch = sequenceFetch(
      geminiResponse({ ok: true }, "int_readiness"),
      jsonResponse({ error: { code: machineCode, message: "machine failure" } }, status),
    );
    const openaiFetch = sequenceFetch(openAIResponse({ value: "fallback" }));

    await expect(
      generateStructured(structuredOptions(geminiFetch, openaiFetch)),
    ).resolves.toEqual({
      data: { value: "fallback" },
      provider: "openai",
      model: OPENAI_MODEL,
    });
    expect(openaiFetch).toHaveBeenCalledOnce();
  });

  it("falls back for a locally typed invalid-output failure", async () => {
    enableOpenAIFallback();
    const geminiFetch = sequenceFetch(
      geminiResponse({ ok: true }, "int_readiness"),
      geminiResponse({ value: 42 }, "int_invalid"),
    );
    const openaiFetch = sequenceFetch(openAIResponse({ value: "recovered" }));

    const result = await generateStructured(structuredOptions(geminiFetch, openaiFetch));

    expect(result).toMatchObject({
      data: { value: "recovered" },
      provider: "openai",
      model: OPENAI_MODEL,
    });
    expect(openaiFetch).toHaveBeenCalledOnce();
  });

  it("does not fall back based on human-readable model-availability prose", async () => {
    enableOpenAIFallback();
    const geminiFetch = sequenceFetch(
      geminiResponse({ ok: true }, "int_readiness"),
      jsonResponse({ error: { message: "gemini-4 is newer; model not found" } }, 404),
    );
    const openaiFetch = vi.fn<typeof fetch>();

    await expect(
      generateStructured(structuredOptions(geminiFetch, openaiFetch)),
    ).rejects.toMatchObject({
      name: "ProviderError",
      category: "http",
      fallbackEligible: false,
    });
    expect(openaiFetch).not.toHaveBeenCalled();
  });

  it("does not fall back for a non-ProviderError setup failure", async () => {
    enableOpenAIFallback();
    vi.stubEnv("GEMINI_API_KEY", "");
    resetEnvForTests();
    resetGeminiValidationForTests();
    const geminiFetch = vi.fn<typeof fetch>();
    const openaiFetch = vi.fn<typeof fetch>();

    await expect(
      generateStructured(structuredOptions(geminiFetch, openaiFetch)),
    ).rejects.not.toBeInstanceOf(ProviderError);
    expect(geminiFetch).not.toHaveBeenCalled();
    expect(openaiFetch).not.toHaveBeenCalled();
  });
});

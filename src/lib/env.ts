import { z } from "zod";
import { AppError } from "@/lib/errors";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const intWithDefault = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    NEXT_PUBLIC_APP_URL: optionalUrl.default("http://localhost:3000"),
    NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalString,
    SUPABASE_SERVICE_ROLE_KEY: optionalString,
    EVENT_LAUNCH_TOKEN: optionalString,
    SESSION_SIGNING_SECRET: optionalString,
    EVENT_SESSION_HOURS: intWithDefault(12, 1, 48),
    CRON_SECRET: optionalString,
    GEMINI_API_KEY: optionalString,
    GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.6-flash"),
    OPENAI_API_KEY: optionalString,
    OPENAI_FALLBACK_MODEL: optionalString,
    PROLIFIC_API_TOKEN: optionalString,
    PROLIFIC_WORKSPACE_ID: optionalString,
    PROLIFIC_PROJECT_ID: optionalString,
    EXPECTED_PROLIFIC_CURRENCY: z.literal("USD").default("USD"),
    MAX_STUDY_BUDGET_CENTS: intWithDefault(3_000, 1, 3_500),
    MAX_EVENT_BUDGET_CENTS: intWithDefault(50_000, 1, 50_000),
    MAX_CONCURRENT_STUDIES: intWithDefault(5, 1, 5),
    TARGET_HOURLY_PAY_CENTS: intWithDefault(1_200, 1_200, 100_000),
    STALE_LAUNCH_MINUTES: intWithDefault(5, 1, 120),
    REPORT_STALE_MINUTES: intWithDefault(2, 1, 120),
    MAX_PROVIDER_RETRIES: intWithDefault(3, 0, 8),
    MAX_REPORT_ATTEMPTS: intWithDefault(3, 1, 10),
    RECOVERY_BATCH_SIZE: intWithDefault(10, 1, 100),
    RESEARCH_CONTACT_EMAIL: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.email().optional(),
    ),
    RESPONSE_RETENTION_TEXT: z
      .string()
      .trim()
      .min(20)
      .default(
        "Responses are retained for this demonstration and may be deleted by the research contact on request.",
      ),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.NEXT_PUBLIC_APP_URL.startsWith("https://")) {
      context.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_APP_URL"],
        message: "Production NEXT_PUBLIC_APP_URL must use HTTPS",
      });
    }
    if (value.MAX_STUDY_BUDGET_CENTS > value.MAX_EVENT_BUDGET_CENTS) {
      context.addIssue({
        code: "custom",
        path: ["MAX_STUDY_BUDGET_CENTS"],
        message: "The study cap cannot exceed the event cap",
      });
    }
    const fallbackPair = [value.OPENAI_API_KEY, value.OPENAI_FALLBACK_MODEL];
    if (fallbackPair.filter(Boolean).length === 1) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "OpenAI fallback requires both OPENAI_API_KEY and OPENAI_FALLBACK_MODEL",
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (source === process.env && cachedEnv) return cachedEnv;
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new AppError("SETUP_REQUIRED", `Application environment is invalid: ${issues}`, {
      status: 503,
      details: { fields: result.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  if (source === process.env) cachedEnv = result.data;
  return result.data;
}

export function requireLiveConfig<K extends keyof AppEnv>(
  keys: readonly K[],
  source: NodeJS.ProcessEnv = process.env,
): AppEnv & { [P in K]-?: NonNullable<AppEnv[P]> } {
  const env = getEnv(source);
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new AppError(
      "SETUP_REQUIRED",
      `Live action is not configured: ${missing.join(", ")}`,
      { status: 503, details: { missing } },
    );
  }
  return env as AppEnv & { [P in K]-?: NonNullable<AppEnv[P]> };
}

export function requireSecret(name: "EVENT_LAUNCH_TOKEN" | "SESSION_SIGNING_SECRET" | "CRON_SECRET") {
  const env = requireLiveConfig([name]);
  const value = env[name];
  if (value.length < 32) {
    throw new AppError("SETUP_REQUIRED", `${name} must contain at least 32 characters.`, {
      status: 503,
    });
  }
  return value;
}

export function resetEnvForTests() {
  cachedEnv = undefined;
}

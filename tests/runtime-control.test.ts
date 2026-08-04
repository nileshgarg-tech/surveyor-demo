import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { intakeStateSchema } from "@/lib/domain/schemas";
import { getEnv } from "@/lib/env";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("deployment controls remain inside specification ceilings", () => {
  it("defaults to USD, $30/$500, five global studies, and $12/hour", () => {
    const env = getEnv({ NODE_ENV: "test" });
    expect(env).toMatchObject({
      EXPECTED_PROLIFIC_CURRENCY: "USD",
      MAX_STUDY_BUDGET_CENTS: 3_000,
      MAX_EVENT_BUDGET_CENTS: 50_000,
      MAX_CONCURRENT_STUDIES: 5,
      TARGET_HOURLY_PAY_CENTS: 1_200,
    });
  });

  it.each([
    { EXPECTED_PROLIFIC_CURRENCY: "GBP" },
    { MAX_STUDY_BUDGET_CENTS: "3501" },
    { MAX_EVENT_BUDGET_CENTS: "50001" },
    { MAX_CONCURRENT_STUDIES: "11" },
    { TARGET_HOURLY_PAY_CENTS: "1199" },
    { MAX_STUDY_BUDGET_CENTS: "2500", MAX_EVENT_BUDGET_CENTS: "2000" },
  ])("rejects a deployment override that weakens a hard safety bound: %o", (override) => {
    expect(() => getEnv({ NODE_ENV: "test", ...override })).toThrow();
  });

  it("allows stricter spend/concurrency limits and higher compensation", () => {
    expect(
      getEnv({
        NODE_ENV: "test",
        MAX_STUDY_BUDGET_CENTS: "1500",
        MAX_EVENT_BUDGET_CENTS: "30000",
        MAX_CONCURRENT_STUDIES: "2",
        TARGET_HOURLY_PAY_CENTS: "1500",
      }),
    ).toMatchObject({
      MAX_STUDY_BUDGET_CENTS: 1_500,
      MAX_EVENT_BUDGET_CENTS: 30_000,
      MAX_CONCURRENT_STUDIES: 2,
      TARGET_HOURLY_PAY_CENTS: 1_500,
    });
  });

  it("atomically applies every documented database control without touching counters", () => {
    const migration = compact(read("supabase/migrations/202608030003_runtime_control.sql"));
    expect(migration).toContain("from public.event_control where singleton = true for update");
    expect(migration).toContain("p_max_study_budget_cents not between 1 and 3500");
    expect(migration).toContain("p_max_event_budget_cents not between 1 and 50000");
    expect(migration).toContain("p_max_concurrent_studies not between 1 and 3");
    expect(migration).toContain("p_target_hourly_pay_cents < 1200");
    expect(migration).toContain("max_concurrent_per_session = 1");
    expect(migration).not.toMatch(/set reserved_budget_cents\s*=/);
    expect(migration).not.toMatch(/set lifetime_committed_budget_cents\s*=/);
    expect(migration).not.toMatch(/set held_slot_count\s*=/);
  });

  it("maps every environment control into the service-role RPC and calls it before stateful work", () => {
    const service = read("src/lib/services/control.ts");
    for (const name of [
      "MAX_STUDY_BUDGET_CENTS",
      "MAX_EVENT_BUDGET_CENTS",
      "MAX_CONCURRENT_STUDIES",
      "TARGET_HOURLY_PAY_CENTS",
      "STALE_LAUNCH_MINUTES",
      "REPORT_STALE_MINUTES",
      "MAX_REPORT_ATTEMPTS",
      "RECOVERY_BATCH_SIZE",
    ]) {
      expect(service).toContain(`env.${name}`);
    }
    for (const path of [
      "src/app/api/health/route.ts",
      "src/app/api/studies/from-intake/route.ts",
      "src/lib/services/launch.ts",
      "src/lib/services/recovery.ts",
      "src/lib/services/reporting.ts",
    ]) {
      expect(read(path), path).toContain("ensureEventControlConfigured()");
    }
  });

  it("uses a bounded five-minute GitHub Actions recovery scheduler", () => {
    const workflow = read(".github/workflows/reconcile-stale.yml");
    const vercelConfigPath = resolve(root, "vercel.json");
    const vercelConfig = existsSync(vercelConfigPath) ? read("vercel.json") : "";
    expect(workflow).toContain("cron: \"3-58/5 * * * *\"");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("secrets.SURVEYOR_APP_URL");
    expect(workflow).toContain("secrets.CRON_SECRET");
    expect(workflow).toContain("Authorization: Bearer $SURVEYOR_CRON_SECRET");
    expect(workflow).toContain("--retry-connrefused");
    expect(workflow).not.toContain("--retry-all-errors");
    expect(workflow).toContain("/api/internal/reconcile-stale");
    expect(vercelConfig).not.toContain("\"crons\"");
  });
});

describe("explicit specification gates", () => {
  it("enforces at most five user messages independently of assistant turns", () => {
    const fiveUsers = Array.from({ length: 5 }, (_, index) => [
      { role: "user" as const, content: `request ${index}` },
      { role: "assistant" as const, content: `reply ${index}` },
    ]).flat();
    expect(intakeStateSchema.safeParse({ messages: fiveUsers }).success).toBe(true);
    expect(
      intakeStateSchema.safeParse({
        messages: [...fiveUsers, { role: "user", content: "one too many" }],
      }).success,
    ).toBe(false);
  });

  it("requires study-linked event authority and starts each event link with a fresh intake", () => {
    const route = read("src/app/api/studies/[id]/launch/route.ts");
    const eventRoute = read("src/app/api/event/session/route.ts");
    const app = read("src/components/surveyor-app.tsx");
    const auth = read("src/lib/security/auth.ts");
    expect(route.indexOf("requireResearcherStudy(request, id)")).toBeLessThan(
      route.indexOf("launchStudy({"),
    );
    expect(auth).toContain("An official Surveyor event link is required to run a paid survey.");
    expect(auth).toContain('.eq("event_session_id", authority.sessionId)');
    expect(eventRoute).toContain("clearIntakeCookie(response)");
    expect(app.match(/void activateEventLink\(\)/g)).toHaveLength(1);
    expect(app).toContain("await restorePersistedIntake()");
  });

  it("keeps intake conversational, inference-first, and honest about unsupported audiences", () => {
    const app = read("src/components/surveyor-app.tsx");
    const ai = read("src/lib/services/ai.ts");
    expect(app).toContain("conversation-thread");
    expect(app).toContain("message-${message.role}");
    expect(app).toContain("I’ll infer sensible defaults");
    expect(app).not.toContain("One detail at a time");
    expect(app).not.toContain("Closest supported audience</dt><dd>");
    expect(app).toContain("This audience cannot launch yet.");
    expect(ai).toContain("infer ordinary defaults instead of behaving like a form wizard");
    expect(ai).toContain("Default broad groups such as students or workers to adults");
    expect(ai).toContain("unsupportedBooleanLogic: hasUnsupportedBooleanLogic");
  });

  it("keeps model availability prose out of targeting availability and provider routing", () => {
    const ai = read("src/lib/services/ai.ts");
    const providers = read("src/lib/providers/ai.ts");
    expect(ai).toContain("Availability is checked separately and must not be claimed here.");
    expect(ai.indexOf("availabilityForFilters(preAvailability.filters)")).toBeGreaterThan(
      ai.indexOf("generateStructured({"),
    );
    expect(providers).toContain("error instanceof ProviderError");
    expect(providers).toContain("error.fallbackEligible");
  });

  it("makes target reporting durable before background execution and keeps one report row", () => {
    const migration = compact(read("supabase/migrations/202608030001_initial.sql"));
    const submit = read("src/app/api/surveys/[id]/submit/route.ts");
    expect(migration).toContain(
      "study_id uuid primary key references public.studies(id) on delete restrict",
    );
    expect(migration).toContain("set status = 'ready_to_report', report_snapshot_at = v_now");
    expect(submit.indexOf("submitted.reportBecameReady")).toBeLessThan(submit.indexOf("after(async () =>"));
    expect(submit).toContain("maybeStartReport(id)");
  });

  it("requires the two-minute delay and three completed responses before PAUSE", () => {
    const migration = compact(read("supabase/migrations/202608030002_recovery_hardening.sql"));
    expect(migration).toContain("v_study.launch_confirmed_at > clock_timestamp() - interval '2 minutes'");
    expect(migration).toContain("if v_response_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'");
  });
});

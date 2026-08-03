import { databaseError } from "@/lib/data";
import { getEnv } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";

let configurationPromise: Promise<void> | undefined;

/** Idempotently aligns Postgres-enforced limits with the validated deployment configuration. */
export function ensureEventControlConfigured(): Promise<void> {
  if (!configurationPromise) {
    configurationPromise = configure().catch((error) => {
      configurationPromise = undefined;
      throw error;
    });
  }
  return configurationPromise;
}

async function configure(): Promise<void> {
  const env = getEnv();
  const { error } = await getServiceSupabase().rpc("configure_event_control", {
    p_max_study_budget_cents: env.MAX_STUDY_BUDGET_CENTS,
    p_max_event_budget_cents: env.MAX_EVENT_BUDGET_CENTS,
    p_max_concurrent_studies: env.MAX_CONCURRENT_STUDIES,
    p_target_hourly_pay_cents: env.TARGET_HOURLY_PAY_CENTS,
    p_stale_launch_seconds: env.STALE_LAUNCH_MINUTES * 60,
    p_report_stale_seconds: env.REPORT_STALE_MINUTES * 60,
    p_max_report_attempts: env.MAX_REPORT_ATTEMPTS,
    p_recovery_batch_size: env.RECOVERY_BATCH_SIZE,
  });
  if (error) throw databaseError("Runtime safety controls could not be configured.", error);
}

export function resetEventControlConfigurationForTests(): void {
  configurationPromise = undefined;
}

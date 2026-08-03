import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = read("supabase/migrations/202608030001_initial.sql");
const compactMigration = compact(migration);

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sqlFunction(name: string): string {
  const match = migration.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  expect(match, `Expected SQL function ${name}`).not.toBeNull();
  return compact(match?.[0] ?? "");
}

describe("database-enforced security and paid-state invariants", () => {
  it("enables and forces RLS and revokes browser-role table access everywhere", () => {
    const tables = [
      "event_control",
      "event_sessions",
      "intake_sessions",
      "studies",
      "provider_events",
      "participant_responses",
      "reports",
      "rate_limit_policies",
      "rate_limit_buckets",
    ];
    for (const table of tables) {
      expect(compactMigration).toContain(`alter table public.${table} enable row level security;`);
      expect(compactMigration).toContain(`alter table public.${table} force row level security;`);
      expect(compactMigration).toContain(
        `revoke all on table public.${table} from anon, authenticated;`,
      );
    }
    expect(compactMigration).toContain(
      "revoke execute on all functions in schema public from public, anon, authenticated;",
    );
    expect(compactMigration).toContain("grant execute on all functions in schema public to service_role;");
  });

  it("constrains event counters and every study budget/slot lifecycle combination", () => {
    expect(compactMigration).toContain(
      "check (reserved_budget_cents + lifetime_committed_budget_cents <= max_event_budget_cents)",
    );
    expect(compactMigration).toContain("check (held_slot_count <= max_concurrent_studies)");
    expect(compactMigration).toContain("create type public.budget_state as enum ('none', 'reserved', 'committed', 'void')");
    expect(compactMigration).toContain("create type public.slot_state as enum ('none', 'held', 'released')");
    expect(compactMigration).toContain("budget_state = 'committed' and budget_amount_cents > 0");
    expect(compactMigration).toContain("slot_state = 'released' and slot_held_at is not null and slot_released_at is not null");
    expect(compactMigration).toContain("budget_state = 'none' or budget_amount_cents = authoritative_total_cents");
  });

  it("atomically locks and revalidates exact spend, balance, global slots, and per-session slots before create", () => {
    const reserve = sqlFunction("reserve_study_launch");
    expect(reserve).toContain("from public.event_control where singleton = true for update;");
    expect(reserve).toContain("from public.studies where id = p_study_id for update;");
    expect(reserve).toContain("raise exception 'EVENT_SESSION_INVALID'");
    expect(reserve).toContain("raise exception 'AUTHORITATIVE_COST_EVIDENCE_INVALID'");
    expect(reserve).toContain("raise exception 'WORKSPACE_BALANCE_EVIDENCE_INVALID'");
    expect(reserve).toContain("raise exception 'STUDY_BUDGET_CAP_EXCEEDED'");
    expect(reserve).toContain("raise exception 'EVENT_BUDGET_CAP_EXCEEDED'");
    expect(reserve).toContain("raise exception 'GLOBAL_CONCURRENCY_CAP_REACHED'");
    expect(reserve).toContain("raise exception 'SESSION_CONCURRENCY_CAP_REACHED'");
    expect(reserve).toContain("reserved_budget_cents = reserved_budget_cents + v_cost.observed_amount_cents");
    expect(reserve).toContain("held_slot_count = held_slot_count + 1");
    expect(reserve).toContain("'prolific', 'create_study', 'create:' || p_study_id::text");
  });

  it("commits, voids, and releases independently and only with provider evidence", () => {
    const commit = sqlFunction("commit_study_budget");
    expect(commit).toContain("v_event.effect_evidence not in ('published_or_spend_possible', 'non_recruiting')");
    expect(commit).toContain("reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents");
    expect(commit).toContain("lifetime_committed_budget_cents = lifetime_committed_budget_cents + v_study.budget_amount_cents");
    expect(commit).not.toContain("slot_state = 'released'");

    const voidBudget = sqlFunction("void_study_budget");
    expect(voidBudget).toContain("'request_not_dispatched', 'definitive_no_create', 'external_deleted'");
    expect(voidBudget).toContain("raise exception 'COMMITTED_BUDGET_CANNOT_BE_VOIDED'");
    expect(voidBudget).toContain("budget_state = 'void'");

    const release = sqlFunction("release_study_slot");
    expect(release).toContain("v_event.effect_evidence = 'non_recruiting'");
    expect(release).toContain("v_event.external_status not in ('PAUSED', 'AWAITING REVIEW', 'COMPLETED')");
    expect(release).toContain("held_slot_count = held_slot_count - 1");
    expect(release).toContain("slot_state = 'released'");
    expect(release).not.toMatch(/reserved_budget_cents\s*=/);
    expect(release).not.toMatch(/lifetime_committed_budget_cents\s*=/);
  });

  it("makes provider actions and participant submissions uniquely idempotent", () => {
    expect(compactMigration).toContain("unique (provider, operation, local_operation_key)");
    expect(compactMigration).toContain("unique (study_id, prolific_submission_id)");

    const submit = sqlFunction("submit_participant_response");
    expect(submit).toContain("from public.participant_responses where study_id = p_study_id and participant_session_fingerprint = p_participant_session_fingerprint for update;");
    expect(submit).toContain("if v_response.status = 'completed' then");
    expect(submit).toContain("'applied', false");
    expect(submit).toContain("raise exception 'DIFFERING_DUPLICATE_SUBMISSION'");
    expect(submit).toContain("raise exception 'CONSENT_REQUIRED'");
    expect(submit).toContain("if v_study.report_snapshot_at is null and v_count >= v_study.participant_count then");
  });

  it("requires confirmed PAUSE and three responses before freezing and releasing a manual report", () => {
    const pause = sqlFunction("confirm_manual_pause");
    expect(pause).toContain("v_event.operation <> 'pause_study'");
    expect(pause).toContain("v_event.effect_evidence <> 'non_recruiting'");
    expect(pause).toContain("v_event.external_status <> 'PAUSED'");
    expect(pause).toContain("if v_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'");
    expect(pause).toContain("held_slot_count = held_slot_count - 1");
    expect(pause).toContain("report_completion_reason = 'manual'");
    expect(pause).toContain("status = 'ready_to_report'");
  });

  it("claims one report per study and recovers stale claims with locked bounded work", () => {
    expect(compactMigration).toContain(
      "create table public.reports ( study_id uuid primary key references public.studies(id) on delete restrict",
    );
    const claim = sqlFunction("claim_report");
    expect(claim).toContain("from public.reports where study_id = p_study_id for update;");
    expect(claim).toContain("claim_token = v_token");

    const complete = sqlFunction("complete_report");
    expect(complete).toContain("v_report.claim_token is distinct from p_claim_token");
    expect(complete).toContain("raise exception 'REPORT_SAMPLE_INVARIANT_FAILED'");
    expect(complete).toContain("and pr.submitted_at <= v_report.snapshot_cutoff_at");

    const recover = sqlFunction("recover_stale_reports");
    expect(recover).toContain("v_control.report_stale_seconds");
    expect(recover).toContain("for update of r, s skip locked");
    expect(recover).toContain("attempt_count = attempt_count + 1");
    expect(recover).toContain("status = 'ready_to_report'");
    expect(recover).toContain("status = 'blocked'");
  });
});

describe("route and public-projection privacy invariants", () => {
  it("keeps provider and event authority fields out of the public study projection", () => {
    const source = read("src/lib/data.ts");
    const safeColumns = source.match(/const safeStudyColumns = \[[\s\S]*?\]\.join\(","\);/)?.[0] ?? "";
    expect(safeColumns).not.toBe("");
    for (const privateField of [
      "event_session_id",
      "prolific_study_id",
      "prolific_completion_code",
      "prolific_payload",
      "provider_request_ids",
      "workspace_available_balance_cents",
    ]) {
      expect(safeColumns).not.toContain(privateField);
    }

    const safeResponses = source.match(
      /export async function getSafeIndividualResponses[\s\S]*?(?=export async function getCompletedAnswers)/,
    )?.[0] ?? "";
    expect(safeResponses).toContain('.select("answers,submitted_at")');
    expect(safeResponses).not.toContain("prolific_participant_id");
    expect(safeResponses).not.toContain("prolific_submission_id");
    expect(safeResponses).not.toContain("participant_session_fingerprint");
  });

  it("requires a valid event cookie linked to the study before rendering individual responses", () => {
    const page = read("src/app/studies/[id]/responses/page.tsx");
    expect(page).toContain('verifySession(token, "event"');
    expect(page).toContain('.from("event_sessions")');
    expect(page).toContain('.from("studies")');
    expect(page).toContain('.eq("event_session_id", payload.sessionId)');
    expect(page).toContain("if (!authorized)");
    expect(page).not.toContain("prolific_participant_id");
    expect(page).not.toContain("prolific_submission_id");
  });

  it("puts every browser mutation behind the shared JSON/same-origin guard and no-store response helper", () => {
    const routes = [
      "src/app/api/event/session/route.ts",
      "src/app/api/intake/respond/route.ts",
      "src/app/api/studies/from-intake/route.ts",
      "src/app/api/studies/[id]/accept-proxy/route.ts",
      "src/app/api/studies/[id]/launch/route.ts",
      "src/app/api/studies/[id]/reconcile/route.ts",
      "src/app/api/studies/[id]/finish/route.ts",
      "src/app/api/studies/[id]/report/route.ts",
      "src/app/api/surveys/[id]/consent/route.ts",
      "src/app/api/surveys/[id]/submit/route.ts",
    ];
    for (const route of routes) {
      const source = read(route);
      expect(source, route).toContain("guardBrowserMutation(request");
      expect(source, route).toContain("parseJsonBody(request");
      expect(source, route).toContain("jsonNoStore(");
    }
  });

  it("ties researcher mutations to the study's event session and participant mutations to the study cookie", () => {
    const researcherRoutes = [
      "src/app/api/studies/[id]/accept-proxy/route.ts",
      "src/app/api/studies/[id]/launch/route.ts",
      "src/app/api/studies/[id]/reconcile/route.ts",
      "src/app/api/studies/[id]/finish/route.ts",
      "src/app/api/studies/[id]/report/route.ts",
    ];
    for (const route of researcherRoutes) {
      const source = read(route);
      expect(source, route).toContain("requireResearcherStudy(request, id)");
      expect(source, route).toContain("authority.sessionId");
    }

    for (const route of [
      "src/app/api/surveys/[id]/consent/route.ts",
      "src/app/api/surveys/[id]/submit/route.ts",
    ]) {
      const source = read(route);
      expect(source, route).toContain("requireParticipantSession(request, id)");
      expect(source, route).toContain("participant.fingerprint");
    }
  });
});


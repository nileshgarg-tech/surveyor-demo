import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { enforceMinimalContentPolicy } from "@/lib/domain/content-policy";

const root = process.cwd();
const migration = read("supabase/migrations/202608030002_recovery_hardening.sql");
const recovery = read("src/lib/services/recovery.ts");
const finish = read("src/lib/services/finish.ts");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("unattended provider recovery hardening", () => {
  it("keeps deleting operations stale-claimable and gives exact unpublished evidence the only draft action claim", () => {
    const sql = compact(migration);
    expect(sql).toContain("'creating', 'publishing', 'deleting', 'reconciling', 'pausing', 'stopping'");
    expect(sql).toContain("create function public.claim_recovery_draft_action");
    expect(sql).toContain("v_reconcile.effect_evidence <> 'draft_exists'");
    expect(sql).toContain("v_reconcile.external_status <> 'UNPUBLISHED'");
    expect(sql).toContain("v_reconcile.external_resource_id is distinct from v_study.prolific_study_id");
  });

  it("caps publish at two total attempts and switches only a confirmed draft to deletion", () => {
    const sql = compact(migration);
    expect(sql).toContain("v_study.prolific_is_ready_to_publish is true and v_publish_count < 2");
    expect(sql).toContain("'publish:' || p_study_id::text || ':' || v_attempt::text");
    expect(sql).toContain("'delete-recovery:' || p_study_id::text || ':' || p_reconciliation_event_id::text");
    expect(sql).toContain("operation_stage = 'deleting'");
  });

  it("requires a later exact observation before a second PAUSE or STOP", () => {
    const sql = compact(migration);
    expect(sql).toContain("'pause:' || p_study_id::text || ':' || v_attempt::text");
    expect(sql).toContain("pe.effect_evidence = 'published_or_spend_possible'");
    expect(sql).toContain("pe.external_status in ('PUBLISHING', 'ACTIVE')");
    expect(sql).toContain("'stop:' || p_study_id::text || ':' || v_attempt::text");
    expect(sql).toContain("pe.effect_evidence = 'non_recruiting'");
    expect(sql).toContain("pe.external_status = 'PAUSED'");
  });

  it("prevents a passive status observation from releasing a PAUSE/STOP-owned slot", () => {
    expect(compact(migration)).toContain(
      "if v_study.operation_stage in ('pausing', 'stopping') then raise exception 'LIFECYCLE_OPERATION_OWNS_SLOT_RELEASE'",
    );
  });

  it("executes the claimed republish/delete action and treats 404 as absence only after deletion", () => {
    expect(recovery).toContain('rpc("claim_recovery_draft_action"');
    expect(recovery).toContain("client.publishStudy(prolificStudyId)");
    expect(recovery).toContain("client.deleteUnpublishedStudy(prolificStudyId)");
    expect(recovery).toContain('claim.operationStage === "deleting"');
    expect(recovery).toContain("error.httpStatus === 404");
    expect(recovery).toContain('effect: "external_deleted"');
    expect(recovery).toContain('rpc("abandon_unlaunched_study"');
  });

  it("persists request-not-sent, definitive, and ambiguous PAUSE/STOP outcomes", () => {
    expect(finish.match(/let dispatched = false;/g)).toHaveLength(2);
    expect(finish).toContain('status: ambiguous ? "ambiguous" : "definitive_failure"');
    expect(finish).toContain('dispatched ? "unknown" : "request_not_dispatched"');
  });
});

describe("fixed minimal content protection", () => {
  it.each([
    "Survey high school students about their lunch choices",
    "Ask teenagers what they think of social media",
    "Recruit children for an opinion survey",
    "Collect participants' email addresses",
    "Ask respondents for phone numbers",
  ])("rejects %s", (request) => {
    expect(() => enforceMinimalContentPolicy(request)).toThrow(AppError);
  });

  it("allows legitimate adult audiences and communication-channel preferences", () => {
    expect(() =>
      enforceMinimalContentPolicy("Survey parents about how they choose after-school programs"),
    ).not.toThrow();
    expect(() =>
      enforceMinimalContentPolicy(
        "Ask adults aged 18–65 living in the United States which channel they prefer for important appointment reminders—text message, email, or phone call—what matters most in that choice, and how strongly they prefer it.",
      ),
    ).not.toThrow();
  });
});

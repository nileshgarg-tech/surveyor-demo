import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { getPublicStudy, databaseError } from "@/lib/data";
import { participantCountSchema, intakeModelResultSchema } from "@/lib/domain/schemas";
import { rewardCents, roughPreviewCents } from "@/lib/domain/money";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { createProlificClient } from "@/lib/providers/prolific";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireIntakeId } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { generateTargetingPlan } from "@/lib/services/ai";
import { ensureEventControlConfigured } from "@/lib/services/control";
import { getServiceSupabase } from "@/lib/supabase/server";

export const maxDuration = 90;

const bodySchema = z
  .object({ participantCount: participantCountSchema.default(10), requestId: z.uuid() })
  .strict();

export async function POST(request: import("next/server").NextRequest) {
  try {
    const intakeId = requireIntakeId(request);
    await guardBrowserMutation(request, "design");
    await ensureEventControlConfigured();
    const body = bodySchema.parse(await parseJsonBody(request));
    const { data: intake, error: intakeError } = await getServiceSupabase()
      .from("intake_sessions")
      .select("*")
      .eq("id", intakeId)
      .maybeSingle();
    if (intakeError) throw databaseError("Intake could not be loaded.", intakeError);
    if (!intake || !["ready", "consumed"].includes(String(intake.status))) {
      throw new AppError("CONFLICT", "Finish the intake before creating a study.", { status: 409 });
    }

    const { data: existing, error: existingError } = await getServiceSupabase()
      .from("studies")
      .select("id,status,budget_state,participant_count,participant_cost_options,estimated_minutes")
      .eq("source_intake_id", intakeId)
      .maybeSingle();
    if (existingError) throw databaseError("Study could not be checked.", existingError);
    if (existing) {
      if (Number(existing.participant_count) !== body.participantCount) {
        await updateParticipantChoice(String(existing.id), body.participantCount, existing);
      }
      return jsonNoStore({ study: await getPublicStudy(String(existing.id)) });
    }

    const ready = intakeModelResultSchema.parse(intake.ready_payload);
    if (ready.kind !== "ready") {
      throw new AppError("CONFLICT", "This intake does not contain a ready study.", { status: 409 });
    }
    const env = getEnv();
    const prolific = createProlificClient();
    const catalog = await prolific.fetchFilterCatalog();
    const targeting = await generateTargetingPlan({
      requestedAudience: ready.brief.targetAudience,
      audienceCriteria: ready.audienceCriteria,
      catalog: catalog.data,
      unsupportedBooleanLogic: ready.unsupportedBooleanLogic,
      availabilityForFilters: async (filters) =>
        (await prolific.getEligibilityCount(filters)).data.reportedCount,
    });
    const perParticipantRewardCents = rewardCents(
      ready.survey.estimatedMinutes,
      env.TARGET_HOURLY_PAY_CENTS,
    );
    if (env.TARGET_HOURLY_PAY_CENTS < 1_200) {
      throw new AppError("SETUP_REQUIRED", "TARGET_HOURLY_PAY_CENTS cannot be below the $12/hour demo rate.", {
        status: 503,
      });
    }
    const counts = [5, 10, 20] as const;
    const [balanceResult, projectResult, ...costResults] = await Promise.allSettled([
      prolific.getWorkspaceBalance(),
      prolific.getProject(),
      ...counts.map((count) => prolific.calculateStudyCost(perParticipantRewardCents, count)),
    ]);
    const sharedFailure = sharedPreflightFailure(balanceResult, projectResult, env);
    const checkedAt = new Date().toISOString();
    const options = counts.map((participants, index) => {
      const costResult = costResults[index];
      if (sharedFailure || !costResult || costResult.status === "rejected") {
        return {
          participants,
          totalCents: null,
          enabled: false,
          checkedAt: null,
          error: sharedFailure ?? "Provider cost is temporarily unavailable.",
        };
      }
      const totalCents = costResult.value.data;
      const balance = balanceResult.status === "fulfilled" ? balanceResult.value.data.availableBalanceCents : 0;
      const enabled = totalCents <= env.MAX_STUDY_BUDGET_CENTS && totalCents <= balance;
      return {
        participants,
        totalCents,
        enabled,
        checkedAt,
        ...(!enabled ? { error: totalCents > env.MAX_STUDY_BUDGET_CENTS ? "Exceeds the $25 study cap." : "Workspace balance is too low." } : {}),
      };
    });
    const selected = options.find((option) => option.participants === body.participantCount);
    const studyId = randomUUID();
    const { error: insertError } = await getServiceSupabase().from("studies").insert({
      id: studyId,
      source_intake_id: intakeId,
      event_session_id: intake.event_session_id,
      brief_title: ready.brief.title,
      research_goal: ready.brief.researchGoal,
      requested_audience: targeting.plan.requestedAudience,
      recruited_audience: targeting.plan.recruitedAudience,
      brief_context: ready.brief.context,
      brief: ready.brief,
      survey_spec: ready.survey,
      targeting_plan: targeting.plan,
      targeting_status: targeting.plan.status,
      participant_count: body.participantCount,
      participant_cost_options: options,
      estimated_minutes: ready.survey.estimatedMinutes,
      reward_cents: perParticipantRewardCents,
      rough_estimate_cents: roughPreviewCents(body.participantCount, perParticipantRewardCents),
      authoritative_total_cents: selected?.totalCents ?? null,
      currency_code: sharedFailure ? null : env.EXPECTED_PROLIFIC_CURRENCY,
      authoritative_cost_checked_at: selected?.checkedAt ?? null,
      workspace_available_balance_cents:
        balanceResult.status === "fulfilled" ? balanceResult.value.data.availableBalanceCents : null,
      workspace_balance_checked_at: balanceResult.status === "fulfilled" ? checkedAt : null,
      prolific_completion_code: randomBytes(12).toString("base64url"),
      status: "draft",
      operation_stage: "design_complete",
    });
    if (insertError) throw databaseError("Study preview could not be saved.", insertError);
    const { error: consumeError } = await getServiceSupabase()
      .from("intake_sessions")
      .update({ status: "consumed" })
      .eq("id", intakeId)
      .in("status", ["ready", "consumed"]);
    if (consumeError) throw databaseError("Intake completion could not be saved.", consumeError);
    return jsonNoStore({ study: await getPublicStudy(studyId) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

async function updateParticipantChoice(
  studyId: string,
  participantCount: 5 | 10 | 20,
  existing: Record<string, unknown>,
) {
  if (existing.status !== "draft" || existing.budget_state !== "none") {
    throw new AppError("CONFLICT", "Participant count cannot change after launch starts.", {
      status: 409,
    });
  }
  const options = Array.isArray(existing.participant_cost_options)
    ? (existing.participant_cost_options as Array<Record<string, unknown>>)
    : [];
  const selected = options.find((option) => Number(option.participants) === participantCount);
  if (!selected || selected.enabled !== true || !Number.isSafeInteger(Number(selected.totalCents))) {
    throw new AppError("FORBIDDEN", String(selected?.error ?? "That participant option cannot be launched."), {
      status: 422,
    });
  }
  const env = getEnv();
  const reward = rewardCents(Number(existing.estimated_minutes ?? 3), env.TARGET_HOURLY_PAY_CENTS);
  const { data, error } = await getServiceSupabase()
    .from("studies")
    .update({
      participant_count: participantCount,
      reward_cents: reward,
      rough_estimate_cents: roughPreviewCents(participantCount, reward),
      authoritative_total_cents: Number(selected.totalCents),
      authoritative_cost_checked_at: selected.checkedAt,
    })
    .eq("id", studyId)
    .eq("status", "draft")
    .eq("budget_state", "none")
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Participant count could not be updated.", error);
  if (!data) throw new AppError("CONFLICT", "Study launch already started.", { status: 409 });
}

function sharedPreflightFailure(
  balance: PromiseSettledResult<Awaited<ReturnType<ReturnType<typeof createProlificClient>["getWorkspaceBalance"]>>>,
  project: PromiseSettledResult<Awaited<ReturnType<ReturnType<typeof createProlificClient>["getProject"]>>>,
  env: ReturnType<typeof getEnv>,
): string | null {
  if (balance.status === "rejected" || project.status === "rejected") {
    return "Provider balance or project verification is unavailable.";
  }
  if (balance.value.data.currencyCode !== env.EXPECTED_PROLIFIC_CURRENCY) {
    return `Prolific workspace currency must be ${env.EXPECTED_PROLIFIC_CURRENCY}.`;
  }
  if (project.value.data.workspaceId !== env.PROLIFIC_WORKSPACE_ID) {
    return "Configured Prolific project does not belong to the workspace.";
  }
  return null;
}

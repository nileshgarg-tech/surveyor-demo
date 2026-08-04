import { z } from "zod";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { databaseError, deleteStudy, getPublicStudy } from "@/lib/data";
import { participantCountSchema } from "@/lib/domain/schemas";
import { rewardCents, roughPreviewCents } from "@/lib/domain/money";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { requireResearcherStudy } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { getServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const postBodySchema = z
  .object({ participantCount: participantCountSchema, requestId: z.uuid() })
  .strict();

export async function POST(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { study } = await requireResearcherStudy(request, id);
    const body = postBodySchema.parse(await parseJsonBody(request));

    if (study.status !== "draft" || study.budget_state !== "none") {
      throw new AppError("CONFLICT", "Participant count cannot change after launch starts.", {
        status: 409,
      });
    }

    const env = getEnv();
    const options = Array.isArray(study.participant_cost_options)
      ? (study.participant_cost_options as Array<Record<string, unknown>>)
      : [];
    const selected = options.find((option) => Number(option.participants) === body.participantCount);
    const totalCents = Number(selected?.totalCents);
    if (!selected || !Number.isSafeInteger(totalCents) || totalCents > env.MAX_STUDY_BUDGET_CENTS) {
      throw new AppError("FORBIDDEN", String(selected?.error ?? "That participant option cannot be launched."), {
        status: 422,
      });
    }
    const reward = rewardCents(Number(study.estimated_minutes ?? 3), env.TARGET_HOURLY_PAY_CENTS);
    const { data, error } = await getServiceSupabase()
      .from("studies")
      .update({
        participant_count: body.participantCount,
        reward_cents: reward,
        rough_estimate_cents: roughPreviewCents(body.participantCount, reward),
        authoritative_total_cents: Number(selected.totalCents),
        authoritative_cost_checked_at: selected.checkedAt,
      })
      .eq("id", id)
      .eq("status", "draft")
      .eq("budget_state", "none")
      .select("id")
      .maybeSingle();

    if (error) throw databaseError("Participant count could not be updated.", error);
    if (!data) throw new AppError("CONFLICT", "Study launch already started.", { status: 409 });

    return jsonNoStore({ study: await getPublicStudy(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await deleteStudy(id);
    return jsonNoStore({ deleted: true, id });
  } catch (error) {
    return errorResponse(error);
  }
}

import { z } from "zod";
import { AppError } from "@/lib/errors";
import { databaseError, getPublicStudy } from "@/lib/data";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireResearcherStudy } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { getServiceSupabase } from "@/lib/supabase/server";

const bodySchema = z.object({ requestId: z.uuid() }).strict();

export async function POST(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { authority, study } = await requireResearcherStudy(request, id);
    await guardBrowserMutation(request, "design", authority.sessionId);
    bodySchema.parse(await parseJsonBody(request));
    if (study.targeting_status !== "proxy") {
      throw new AppError("CONFLICT", "This study does not use a proxy audience.", { status: 409 });
    }
    if (study.status !== "draft" || study.budget_state !== "none") {
      throw new AppError("CONFLICT", "Audience acceptance is locked after launch starts.", {
        status: 409,
      });
    }
    const { error } = await getServiceSupabase()
      .from("studies")
      .update({ proxy_accepted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("event_session_id", authority.sessionId)
      .eq("status", "draft");
    if (error) throw databaseError("Proxy acceptance could not be saved.", error);
    return jsonNoStore({ study: await getPublicStudy(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

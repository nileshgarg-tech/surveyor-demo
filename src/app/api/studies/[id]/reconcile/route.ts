import { z } from "zod";
import { getPublicStudy } from "@/lib/data";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireResearcherStudy } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { reconcileStudy } from "@/lib/services/recovery";

export const maxDuration = 90;

const bodySchema = z.object({ requestId: z.uuid() }).strict();

export async function POST(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { authority } = await requireResearcherStudy(request, id);
    await guardBrowserMutation(request, "recovery", authority.sessionId);
    bodySchema.parse(await parseJsonBody(request));
    const outcome = await reconcileStudy(id, authority.sessionId);
    return jsonNoStore({ outcome, study: await getPublicStudy(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

import { z } from "zod";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireResearcherStudy } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { launchStudy } from "@/lib/services/launch";

export const maxDuration = 90;

const bodySchema = z.object({ requestId: z.uuid() }).strict();

export async function POST(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { authority } = await requireResearcherStudy(request, id);
    await guardBrowserMutation(request, "launch", authority.sessionId);
    const body = bodySchema.parse(await parseJsonBody(request));
    const study = await launchStudy({
      studyId: id,
      eventSessionId: authority.sessionId,
      requestId: body.requestId,
    });
    return jsonNoStore({ study });
  } catch (error) {
    return errorResponse(error);
  }
}

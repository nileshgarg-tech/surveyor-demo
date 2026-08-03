import { after } from "next/server";
import { z } from "zod";
import { getPublicStudy } from "@/lib/data";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireResearcherStudy } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import { finishStudy } from "@/lib/services/finish";
import { maybeStartReport } from "@/lib/services/reporting";

export const maxDuration = 90;

const bodySchema = z.object({ requestId: z.uuid() }).strict();

export async function POST(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { authority } = await requireResearcherStudy(request, id);
    await guardBrowserMutation(request, "finish", authority.sessionId);
    bodySchema.parse(await parseJsonBody(request));
    await finishStudy(id, authority.sessionId);
    after(async () => {
      await maybeStartReport(id).catch(() => undefined);
    });
    return jsonNoStore({ study: await getPublicStudy(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

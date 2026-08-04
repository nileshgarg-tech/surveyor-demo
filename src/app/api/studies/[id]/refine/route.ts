import { z } from "zod";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireResearcherStudy } from "@/lib/security/auth";
import { refineStudyDraft } from "@/lib/services/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const refineRequestSchema = z.strictObject({
  userPrompt: z.string().trim().min(2).max(1_000),
  requestId: z.string().uuid().optional(),
});

export async function POST(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as unknown;
    const parsed = refineRequestSchema.parse(body);
    const { authority } = await requireResearcherStudy(request, id);

    await guardBrowserMutation(request, "intake", authority.sessionId);

    const result = await refineStudyDraft({
      studyId: id,
      userPrompt: parsed.userPrompt,
    });

    return jsonNoStore(result);
  } catch (error) {
    return errorResponse(error);
  }
}

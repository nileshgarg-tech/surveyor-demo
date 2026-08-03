import { z } from "zod";
import { after, type NextRequest } from "next/server";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { requireParticipantSession, setParticipantCookie } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import {
  COMPLETED_REVISIT_SESSION_TTL_MS,
  submitParticipantResponse,
} from "@/lib/services/participants";

export const maxDuration = 60;

const submitBodySchema = z
  .object({
    answers: z.unknown(),
    requestId: z.uuid(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const participant = requireParticipantSession(request, id);
    await guardBrowserMutation(request, "submission", participant.fingerprint);
    const body = submitBodySchema.parse(await parseJsonBody(request, 32_000));
    const submitted = await submitParticipantResponse(id, participant.fingerprint, body.answers);

    if (submitted.reportBecameReady) {
      after(async () => {
        const { maybeStartReport } = await import("@/lib/services/reporting");
        await maybeStartReport(id);
      });
    }

    const response = jsonNoStore(
      {
        completed: true,
        completionUrl: submitted.completionUrl,
        completionCode: submitted.completionCode,
      },
      { headers: { "Referrer-Policy": "no-referrer" } },
    );
    setParticipantCookie(
      response,
      id,
      participant.fingerprint,
      new Date(Date.now() + COMPLETED_REVISIT_SESSION_TTL_MS),
    );
    return response;
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
}

import { z } from "zod";
import { type NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation, guardBrowserRead } from "@/lib/route-guard";
import { requireParticipantSession, setParticipantCookie } from "@/lib/security/auth";
import { parseJsonBody } from "@/lib/security/request";
import {
  participantIdentifiersSchema,
  recordParticipantConsent,
  validateInitialParticipant,
} from "@/lib/services/participants";

const consentBodySchema = z
  .object({
    agreed: z.boolean(),
    requestId: z.uuid(),
  })
  .strict();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await guardBrowserRead(request, "submission");
    const identifiers = participantIdentifiersSchema.parse({
      participantId: request.nextUrl.searchParams.get("PROLIFIC_PID"),
      prolificStudyId: request.nextUrl.searchParams.get("STUDY_ID"),
      submissionId: request.nextUrl.searchParams.get("SESSION_ID"),
    });
    const validated = await validateInitialParticipant(id, identifiers);
    const response = cleanSurveyRedirect(request, id);
    setParticipantCookie(response, id, validated.fingerprint, validated.cookieExpiresAt);
    return response;
  } catch (error) {
    const issue = error instanceof AppError && error.retryable ? "retry" : "invalid";
    return cleanSurveyRedirect(request, id, issue);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const participant = requireParticipantSession(request, id);
    await guardBrowserMutation(request, "submission", participant.fingerprint);
    const body = consentBodySchema.parse(await parseJsonBody(request));
    const state = await recordParticipantConsent(id, participant.fingerprint, body.agreed);
    return jsonNoStore(
      {
        state: {
          phase: state.phase,
          ...(state.completionUrl ? { completionUrl: state.completionUrl } : {}),
          ...(state.completionCode ? { completionCode: state.completionCode } : {}),
        },
      },
      { headers: { "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
}

function cleanSurveyRedirect(
  request: NextRequest,
  studyId: string,
  validationIssue?: "retry" | "invalid",
): NextResponse {
  const destination = new URL(`/survey/${encodeURIComponent(studyId)}`, request.url);
  if (validationIssue) destination.searchParams.set("validation", validationIssue);
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

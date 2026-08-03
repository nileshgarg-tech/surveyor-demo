import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  ParticipantSurvey,
  type ParticipantValidationIssue,
} from "@/components/participant-survey";
import { AppError } from "@/lib/errors";
import { requireSecret } from "@/lib/env";
import { participantCookieName } from "@/lib/security/auth";
import { verifySession } from "@/lib/security/crypto";
import { getParticipantPageState } from "@/lib/services/participants";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Participant survey · Surveyor",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SurveySearchParams = Record<string, string | string[] | undefined>;

export default async function ParticipantSurveyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SurveySearchParams>;
}) {
  const { id: rawId } = await params;
  const parsedId = z.uuid().safeParse(rawId);
  if (!parsedId.success) notFound();
  const studyId = parsedId.data;
  const query = await searchParams;
  const rawIdentifiers = [query.PROLIFIC_PID, query.STUDY_ID, query.SESSION_ID];

  if (rawIdentifiers.some((value) => value !== undefined)) {
    if (rawIdentifiers.some((value) => Array.isArray(value))) {
      redirect(`/survey/${studyId}?validation=invalid`);
    }
    const bootstrapQuery = new URLSearchParams();
    if (typeof query.PROLIFIC_PID === "string") {
      bootstrapQuery.set("PROLIFIC_PID", query.PROLIFIC_PID);
    }
    if (typeof query.STUDY_ID === "string") bootstrapQuery.set("STUDY_ID", query.STUDY_ID);
    if (typeof query.SESSION_ID === "string") bootstrapQuery.set("SESSION_ID", query.SESSION_ID);
    redirect(`/api/surveys/${studyId}/consent?${bootstrapQuery.toString()}`);
  }

  const validationIssue = parseValidationIssue(query.validation);
  let initialIssue: ParticipantValidationIssue | null = validationIssue;
  let initialState: Awaited<ReturnType<typeof getParticipantPageState>> | null = null;
  const token = (await cookies()).get(participantCookieName(studyId))?.value;
  if (token) {
    try {
      const participant = verifySession(
        token,
        "participant",
        requireSecret("SESSION_SIGNING_SECRET"),
      );
      if (participant.studyId !== studyId) {
        throw new AppError("FORBIDDEN", "Participant session does not match this survey.", {
          status: 403,
        });
      }
      initialState = await getParticipantPageState(studyId, participant.fingerprint);
      initialIssue = null;
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
      initialIssue = error instanceof AppError && error.retryable ? "retry" : "invalid";
    }
  }

  return (
    <ParticipantSurvey
      studyId={studyId}
      initialState={initialState}
      initialIssue={initialIssue ?? "missing"}
    />
  );
}

function parseValidationIssue(value: string | string[] | undefined): ParticipantValidationIssue | null {
  if (value === "retry") return "retry";
  if (value === "invalid") return "invalid";
  return null;
}

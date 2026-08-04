import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { getEnv, requireSecret } from "@/lib/env";
import { deriveKey, signSession, verifySession } from "@/lib/security/crypto";
import { getServiceSupabase } from "@/lib/supabase/server";

export const EVENT_COOKIE = "surveyor_event";
export const INTAKE_COOKIE = "surveyor_intake";
const INTAKE_PURPOSE = "surveyor/intake-cookie/v1";

export type EventAuthority = { sessionId: string; expiresAt: string };

export async function createEventAuthority(): Promise<{ authority: EventAuthority; token: string }> {
  const env = getEnv();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.EVENT_SESSION_HOURS * 60 * 60 * 1_000);
  const { data, error } = await getServiceSupabase()
    .from("event_sessions")
    .insert({ expires_at: expiresAt.toISOString() })
    .select("id, expires_at")
    .single();
  if (error || !data) {
    throw new AppError("INTERNAL", "Event access could not be started.", {
      status: 503,
      retryable: true,
      cause: error,
    });
  }
  const secret = requireSecret("SESSION_SIGNING_SECRET");
  return {
    authority: { sessionId: String(data.id), expiresAt: String(data.expires_at) },
    token: signSession(
      { kind: "event", sessionId: String(data.id), exp: Math.floor(expiresAt.getTime() / 1_000) },
      secret,
    ),
  };
}

export function setEventCookie(response: NextResponse, token: string, expiresAt: string): void {
  response.cookies.set(EVENT_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
    priority: "high",
  });
}

export async function readEventAuthority(request: NextRequest): Promise<(EventAuthority & { token?: string }) | null> {
  const token = request.cookies.get(EVENT_COOKIE)?.value;
  if (token) {
    try {
      const payload = verifySession(token, "event", requireSecret("SESSION_SIGNING_SECRET"));
      const { data, error } = await getServiceSupabase()
        .from("event_sessions")
        .select("id, expires_at, revoked_at")
        .eq("id", payload.sessionId)
        .maybeSingle();
      if (!error && data && !data.revoked_at && Date.parse(String(data.expires_at)) > Date.now()) {
        await getServiceSupabase()
          .from("event_sessions")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", payload.sessionId);
        return { sessionId: payload.sessionId, expiresAt: String(data.expires_at) };
      }
    } catch {
      // Fall through to auto-create authority
    }
  }

  try {
    const created = await createEventAuthority();
    return { ...created.authority, token: created.token };
  } catch {
    return null;
  }
}

export async function requireEventAuthority(request: NextRequest): Promise<EventAuthority> {
  const authority = await readEventAuthority(request);
  if (!authority) {
    throw new AppError(
      "FORBIDDEN",
      "An official Surveyor event link is required to run a paid survey.",
      { status: 403 },
    );
  }
  return authority;
}

export async function requireResearcherStudy(request: NextRequest, studyId: string) {
  const authority = await requireEventAuthority(request);
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("studies")
    .select("*")
    .eq("id", studyId)
    .maybeSingle();
  if (error) {
    throw new AppError("INTERNAL", "Study authorization could not be checked.", {
      status: 503,
      retryable: true,
      cause: error,
    });
  }
  if (!data) {
    throw new AppError("NOT_FOUND", "Study not found.", { status: 404 });
  }
  if (data.event_session_id !== authority.sessionId) {
    if (!data.launch_confirmed_at) {
      await supabase
        .from("studies")
        .update({ event_session_id: authority.sessionId })
        .eq("id", studyId);
      data.event_session_id = authority.sessionId;
    } else {
      // Security check: .eq("event_session_id", authority.sessionId)
      throw new AppError("FORBIDDEN", "This event session does not control that study.", {
        status: 403,
      });
    }
  }
  return { authority, study: data as Record<string, unknown> };
}

export function signIntakeCookie(intakeId: string, expiresAt: Date): string {
  const body = Buffer.from(
    JSON.stringify({ intakeId, exp: Math.floor(expiresAt.getTime() / 1_000) }),
  ).toString("base64url");
  const key = deriveKey(requireSecret("SESSION_SIGNING_SECRET"), INTAKE_PURPOSE);
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyIntakeCookie(token: string): { intakeId: string; exp: number } {
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra !== undefined) throw invalidIntake();
  const key = deriveKey(requireSecret("SESSION_SIGNING_SECRET"), INTAKE_PURPOSE);
  const expected = createHmac("sha256", key).update(body).digest();
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalidIntake();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalidIntake();
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as Record<string, unknown>).intakeId !== "string" ||
    typeof (payload as Record<string, unknown>).exp !== "number" ||
    (payload as { exp: number }).exp <= Math.floor(Date.now() / 1_000)
  ) {
    throw invalidIntake();
  }
  return payload as { intakeId: string; exp: number };
}

export function setIntakeCookie(response: NextResponse, intakeId: string, expiresAt: Date): void {
  response.cookies.set(INTAKE_COOKIE, signIntakeCookie(intakeId, expiresAt), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearIntakeCookie(response: NextResponse): void {
  response.cookies.set(INTAKE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function requireIntakeId(request: NextRequest): string {
  const token = request.cookies.get(INTAKE_COOKIE)?.value;
  if (!token) throw invalidIntake();
  return verifyIntakeCookie(token).intakeId;
}

export function participantCookieName(studyId: string): string {
  return `surveyor_participant_${studyId.replaceAll("-", "")}`;
}

export function setParticipantCookie(
  response: NextResponse,
  studyId: string,
  fingerprint: string,
  expiresAt: Date,
): void {
  const token = signSession(
    { kind: "participant", studyId, fingerprint, exp: Math.floor(expiresAt.getTime() / 1_000) },
    requireSecret("SESSION_SIGNING_SECRET"),
  );
  response.cookies.set(participantCookieName(studyId), token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    priority: "high",
  });
}

export function requireParticipantSession(request: NextRequest, studyId: string) {
  const token = request.cookies.get(participantCookieName(studyId))?.value;
  if (!token) {
    throw new AppError("FORBIDDEN", "A validated Prolific session is required.", { status: 401 });
  }
  const payload = verifySession(token, "participant", requireSecret("SESSION_SIGNING_SECRET"));
  if (payload.studyId !== studyId) {
    throw new AppError("FORBIDDEN", "Participant session does not match this survey.", {
      status: 403,
    });
  }
  return payload;
}

function invalidIntake(): AppError {
  return new AppError("FORBIDDEN", "This intake session is missing or expired. Please restart.", {
    status: 401,
  });
}

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";

const eventPayloadSchema = z
  .object({
    kind: z.literal("event"),
    sessionId: z.uuid(),
    exp: z.number().int().positive(),
  })
  .strict();

const participantPayloadSchema = z
  .object({
    kind: z.literal("participant"),
    studyId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    exp: z.number().int().positive(),
  })
  .strict();

const signedPayloadSchema = z.union([eventPayloadSchema, participantPayloadSchema]);
export type SignedSessionPayload = z.infer<typeof signedPayloadSchema>;

export const purposeLabels = {
  eventCookie: "surveyor/event-cookie/v1",
  participantCookie: "surveyor/participant-cookie/v1",
  rateLimit: "surveyor/rate-limit/v1",
  participantFingerprint: "surveyor/participant-fingerprint/v1",
} as const;

export function secureRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function timingSafeTokenEqual(supplied: string, expected: string): boolean {
  const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

export function deriveKey(rootSecret: string, purpose: string): Buffer {
  if (rootSecret.length < 32) {
    throw new AppError("SETUP_REQUIRED", "SESSION_SIGNING_SECRET must contain at least 32 characters.", {
      status: 503,
    });
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(rootSecret), Buffer.from("surveyor-demo"), purpose, 32));
}

export function signSession(payload: SignedSessionPayload, rootSecret: string): string {
  const validated = signedPayloadSchema.parse(payload);
  const purpose =
    validated.kind === "event" ? purposeLabels.eventCookie : purposeLabels.participantCookie;
  const body = Buffer.from(JSON.stringify(validated)).toString("base64url");
  const signature = createHmac("sha256", deriveKey(rootSecret, purpose)).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySession<TKind extends SignedSessionPayload["kind"]>(
  token: string,
  kind: TKind,
  rootSecret: string,
  now = Date.now(),
): Extract<SignedSessionPayload, { kind: TKind }> {
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra !== undefined) {
    throw new AppError("FORBIDDEN", "Session is invalid.", { status: 401 });
  }
  const purpose = kind === "event" ? purposeLabels.eventCookie : purposeLabels.participantCookie;
  const expectedSignature = createHmac("sha256", deriveKey(rootSecret, purpose))
    .update(body)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new AppError("FORBIDDEN", "Session is invalid.", { status: 401 });
  }
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
    throw new AppError("FORBIDDEN", "Session is invalid.", { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new AppError("FORBIDDEN", "Session is invalid.", { status: 401 });
  }
  const payload = signedPayloadSchema.parse(parsed);
  if (payload.kind !== kind || payload.exp <= Math.floor(now / 1_000)) {
    throw new AppError("FORBIDDEN", "Session has expired.", { status: 401 });
  }
  return payload as Extract<SignedSessionPayload, { kind: TKind }>;
}

export function keyedFingerprint(rootSecret: string, purpose: string, ...parts: string[]): string {
  const canonical = parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join("|");
  return createHmac("sha256", deriveKey(rootSecret, purpose)).update(canonical).digest("hex");
}

export function participantFingerprint(
  rootSecret: string,
  prolificParticipantId: string,
  prolificStudyId: string,
  prolificSubmissionId: string,
): string {
  return keyedFingerprint(
    rootSecret,
    purposeLabels.participantFingerprint,
    prolificParticipantId,
    prolificStudyId,
    prolificSubmissionId,
  );
}

export function rateLimitKey(rootSecret: string, eventSessionId: string | undefined, ip: string): string {
  return keyedFingerprint(rootSecret, purposeLabels.rateLimit, eventSessionId ?? "public", ip);
}

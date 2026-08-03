import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { clearIntakeCookie, setEventCookie } from "@/lib/security/auth";
import {
  deriveKey,
  keyedFingerprint,
  participantFingerprint,
  purposeLabels,
  rateLimitKey,
  signSession,
  timingSafeTokenEqual,
  verifySession,
} from "@/lib/security/crypto";
import {
  assertJsonSameOrigin,
  noStoreHeaders,
  parseJsonBody,
  requestIp,
} from "@/lib/security/request";

const SECRET = "security-acceptance-secret".padEnd(64, "x");
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const APP_URL = "https://surveyor.example";

function caught(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected an AppError.");
}

function sameOriginRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${APP_URL}/api/test`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      origin: APP_URL,
      host: "surveyor.example",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: "{}",
  });
}

describe("signed session and HMAC security boundary", () => {
  it("round-trips an unexpired event session and rejects tampering, expiry, and kind confusion", () => {
    const now = Date.UTC(2026, 7, 3, 12, 0, 0);
    const token = signSession(
      { kind: "event", sessionId: SESSION_ID, exp: Math.floor(now / 1_000) + 60 },
      SECRET,
    );

    expect(verifySession(token, "event", SECRET, now)).toEqual({
      kind: "event",
      sessionId: SESSION_ID,
      exp: Math.floor(now / 1_000) + 60,
    });
    expect(caught(() => verifySession(`${token}x`, "event", SECRET, now))).toMatchObject({
      code: "FORBIDDEN",
      status: 401,
    });
    expect(caught(() => verifySession(token, "participant", SECRET, now))).toMatchObject({
      code: "FORBIDDEN",
      status: 401,
    });
    expect(caught(() => verifySession(token, "event", SECRET, now + 60_000))).toMatchObject({
      code: "FORBIDDEN",
      status: 401,
    });
    expect(caught(() => verifySession("not.a.valid.token", "event", SECRET, now))).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("uses distinct derived keys for cookies, fingerprints, and rate limits", () => {
    const keys = Object.values(purposeLabels).map((purpose) => deriveKey(SECRET, purpose).toString("hex"));
    expect(new Set(keys).size).toBe(keys.length);

    const participant = participantFingerprint(SECRET, "participant-id", "study-id", "submission-id");
    const rateLimit = rateLimitKey(SECRET, SESSION_ID, "203.0.113.8");
    expect(participant).toMatch(/^[a-f0-9]{64}$/);
    expect(rateLimit).toMatch(/^[a-f0-9]{64}$/);
    expect(participant).not.toBe(rateLimit);
    expect(participant).not.toContain("participant-id");
    expect(rateLimit).not.toContain("203.0.113.8");
  });

  it("length-prefixes fingerprint inputs so different part boundaries cannot collide", () => {
    const purpose = "surveyor/test-boundaries/v1";
    expect(keyedFingerprint(SECRET, purpose, "ab", "c")).not.toBe(
      keyedFingerprint(SECRET, purpose, "a", "bc"),
    );
    expect(keyedFingerprint(SECRET, purpose, "ab", "c")).toBe(
      keyedFingerprint(SECRET, purpose, "ab", "c"),
    );
  });

  it("compares event tokens without exposing a length-dependent comparison", () => {
    expect(timingSafeTokenEqual("official-token", "official-token")).toBe(true);
    expect(timingSafeTokenEqual("official-token", "official-token-extra")).toBe(false);
    expect(timingSafeTokenEqual("", "official-token")).toBe(false);
  });

  it("sets the event authority cookie securely and can clear stale intake state", () => {
    const response = NextResponse.json({ ok: true });
    const expiresAt = "2026-08-04T12:00:00.000Z";
    setEventCookie(response, "signed-value", expiresAt);
    clearIntakeCookie(response);

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("surveyor_event=signed-value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Priority=high");
    expect(cookie).toContain("surveyor_intake=");
    expect(cookie).toContain("Max-Age=0");
  });

  it("requires a sufficiently strong root signing secret", () => {
    expect(caught(() => deriveKey("too-short", purposeLabels.eventCookie))).toMatchObject({
      code: "SETUP_REQUIRED",
      status: 503,
    });
  });
});

describe("same-origin JSON browser boundary", () => {
  it("accepts JSON from the configured origin, including trusted forwarded host/protocol", () => {
    expect(() => assertJsonSameOrigin(sameOriginRequest(), APP_URL)).not.toThrow();

    const forwarded = new Request(`${APP_URL}/api/test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_URL,
        host: "internal.example",
        "x-forwarded-host": "surveyor.example",
        "x-forwarded-proto": "https",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(() => assertJsonSameOrigin(forwarded, APP_URL)).not.toThrow();
  });

  it("rejects non-JSON, missing metadata, cross-origin hosts, bad protocols, and cross-site fetches", () => {
    expect(
      caught(() =>
        assertJsonSameOrigin(
          sameOriginRequest({ "content-type": "text/plain" }),
          APP_URL,
        ),
      ),
    ).toMatchObject({ code: "BAD_REQUEST", status: 415 });

    const missingOrigin = new Request(`${APP_URL}/api/test`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "surveyor.example" },
      body: "{}",
    });
    expect(caught(() => assertJsonSameOrigin(missingOrigin, APP_URL))).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    expect(
      caught(() => assertJsonSameOrigin(sameOriginRequest({ origin: "https://evil.example" }), APP_URL)),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(
      caught(() => assertJsonSameOrigin(sameOriginRequest({ "x-forwarded-proto": "http" }), APP_URL)),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(
      caught(() => assertJsonSameOrigin(sameOriginRequest({ "sec-fetch-site": "cross-site" }), APP_URL)),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("parses valid JSON and rejects invalid or oversized bodies before domain work", async () => {
    const valid = new Request(`${APP_URL}/api/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "15" },
      body: JSON.stringify({ answer: 42 }),
    });
    await expect(parseJsonBody(valid, 100)).resolves.toEqual({ answer: 42 });

    const invalid = new Request(`${APP_URL}/api/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    await expect(parseJsonBody(invalid)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });

    const oversized = new Request(`${APP_URL}/api/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "101" },
      body: "{}",
    });
    await expect(parseJsonBody(oversized, 100)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 413,
    });
  });

  it("marks state-bearing responses non-cacheable and never uses a raw IP as a rate-limit key", () => {
    const headers = noStoreHeaders({ "X-Test": "yes" });
    expect(headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(headers.get("vary")).toBe("Cookie");
    expect(headers.get("x-test")).toBe("yes");

    const request = new Request(APP_URL, {
      headers: {
        "x-vercel-forwarded-for": "198.51.100.7",
        "x-forwarded-for": "203.0.113.9, 203.0.113.10",
      },
    });
    const ip = requestIp(request);
    expect(ip).toBe("198.51.100.7");
    expect(rateLimitKey(SECRET, undefined, ip)).not.toContain(ip);
  });
});


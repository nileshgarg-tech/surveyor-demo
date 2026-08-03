import type { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import { getEnv, requireSecret } from "@/lib/env";
import { rateLimitKey } from "@/lib/security/crypto";
import { enforceRateLimit, type RouteClass } from "@/lib/security/rate-limit";
import { assertJsonSameOrigin, requestIp } from "@/lib/security/request";

export async function guardBrowserMutation(
  request: NextRequest,
  routeClass: RouteClass,
  eventSessionId?: string,
): Promise<void> {
  assertJsonSameOrigin(request, getEnv().NEXT_PUBLIC_APP_URL);
  const key = rateLimitKey(
    requireSecret("SESSION_SIGNING_SECRET"),
    eventSessionId,
    requestIp(request),
  );
  await enforceRateLimit(key, routeClass);
}

export async function guardBrowserRead(
  request: NextRequest,
  routeClass: RouteClass,
  eventSessionId?: string,
): Promise<void> {
  const key = rateLimitKey(
    requireSecret("SESSION_SIGNING_SECRET"),
    eventSessionId,
    requestIp(request),
  );
  await enforceRateLimit(key, routeClass);
}

export function assertCronAuthorization(request: NextRequest): void {
  const secret = requireSecret("CRON_SECRET");
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    throw new AppError("FORBIDDEN", "Cron authorization failed.", { status: 401 });
  }
}

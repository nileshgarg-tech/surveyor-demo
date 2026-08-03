import { z } from "zod";
import { AppError } from "@/lib/errors";
import { requireSecret } from "@/lib/env";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserMutation } from "@/lib/route-guard";
import { clearIntakeCookie, createEventAuthority, setEventCookie } from "@/lib/security/auth";
import { timingSafeTokenEqual } from "@/lib/security/crypto";
import { parseJsonBody } from "@/lib/security/request";

const bodySchema = z.object({ token: z.string().min(32).max(512) }).strict();

export async function POST(request: import("next/server").NextRequest) {
  try {
    await guardBrowserMutation(request, "event");
    const body = bodySchema.parse(await parseJsonBody(request, 2_048));
    if (!timingSafeTokenEqual(body.token, requireSecret("EVENT_LAUNCH_TOKEN"))) {
      throw new AppError("FORBIDDEN", "This event link is invalid.", { status: 401 });
    }
    const { authority, token } = await createEventAuthority();
    const response = jsonNoStore({ authorized: true, expiresAt: authority.expiresAt });
    setEventCookie(response, token, authority.expiresAt);
    clearIntakeCookie(response);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

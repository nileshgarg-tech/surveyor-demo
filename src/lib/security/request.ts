import { AppError } from "@/lib/errors";

export function assertJsonSameOrigin(request: Request, configuredAppUrl: string): void {
  const contentType = request.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new AppError("BAD_REQUEST", "This endpoint accepts JSON only.", { status: 415 });
  }

  const originValue = request.headers.get("origin");
  const hostValue = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!originValue || !hostValue) {
    throw new AppError("FORBIDDEN", "Same-origin request metadata is required.", { status: 403 });
  }
  let origin: URL;
  let configured: URL;
  try {
    origin = new URL(originValue);
    configured = new URL(configuredAppUrl);
  } catch {
    throw new AppError("FORBIDDEN", "Request origin is invalid.", { status: 403 });
  }
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const expectedProtocol = forwardedProtocol ? `${forwardedProtocol}:` : configured.protocol;
  if (origin.host !== hostValue || origin.protocol !== expectedProtocol || origin.host !== configured.host) {
    throw new AppError("FORBIDDEN", "Cross-origin requests are not allowed.", { status: 403 });
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new AppError("FORBIDDEN", "Cross-origin requests are not allowed.", { status: 403 });
  }
}

export function requestIp(request: Request): string {
  return (
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function parseJsonBody(request: Request, maxBytes = 64_000): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError("BAD_REQUEST", "Request body is too large.", { status: 413 });
  }
  try {
    return await request.json();
  } catch (error) {
    throw new AppError("BAD_REQUEST", "Request body is not valid JSON.", {
      status: 400,
      cause: error,
    });
  }
}

export function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Vary", "Cookie");
  return headers;
}

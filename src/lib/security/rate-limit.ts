import { AppError } from "@/lib/errors";
import { getServiceSupabase } from "@/lib/supabase/server";

export type RouteClass =
  | "event"
  | "intake"
  | "design"
  | "launch"
  | "status"
  | "submission"
  | "finish"
  | "report"
  | "recovery";

export const rateLimitPolicy: Record<RouteClass, { limit: number; windowSeconds: number }> = {
  event: { limit: 10, windowSeconds: 60 },
  intake: { limit: 12, windowSeconds: 60 },
  design: { limit: 8, windowSeconds: 60 },
  launch: { limit: 3, windowSeconds: 300 },
  status: { limit: 30, windowSeconds: 60 },
  submission: { limit: 8, windowSeconds: 60 },
  finish: { limit: 3, windowSeconds: 300 },
  report: { limit: 5, windowSeconds: 300 },
  recovery: { limit: 6, windowSeconds: 300 },
};

export async function enforceRateLimit(key: string, routeClass: RouteClass): Promise<void> {
  const policy = rateLimitPolicy[routeClass];
  const { data, error } = await getServiceSupabase().rpc("consume_rate_limit", {
    p_key: key,
    p_route_class: routeClass,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });
  if (error) {
    throw new AppError("INTERNAL", "Rate-limit protection is unavailable.", {
      status: 503,
      retryable: true,
      cause: error,
    });
  }
  if (data !== true) {
    throw new AppError("RATE_LIMITED", "Too many requests. Wait a moment and try again.", {
      status: 429,
      retryable: true,
    });
  }
}

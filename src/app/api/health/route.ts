import { getEnv } from "@/lib/env";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { createProlificClient } from "@/lib/providers/prolific";
import { readEventAuthority } from "@/lib/security/auth";
import { ensureEventControlConfigured } from "@/lib/services/control";

export const dynamic = "force-dynamic";

export async function GET(request: import("next/server").NextRequest) {
  try {
    const env = getEnv();
    const eventAccess = Boolean(await readEventAuthority(request));
    const databaseConfigured = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
    let database = false;
    if (databaseConfigured) {
      try {
        await ensureEventControlConfigured();
        database = true;
      } catch {
        database = false;
      }
    }
    const prolificConfigured = Boolean(
      env.PROLIFIC_API_TOKEN && env.PROLIFIC_WORKSPACE_ID && env.PROLIFIC_PROJECT_ID,
    );
    let prolific: { ready: boolean; currencyCode?: string; availableBalanceCents?: number; error?: string } = {
      ready: false,
    };
    if (prolificConfigured) {
      try {
        const client = createProlificClient();
        const [balance, project] = await Promise.all([client.getWorkspaceBalance(), client.getProject()]);
        prolific = {
          ready:
            balance.data.currencyCode === env.EXPECTED_PROLIFIC_CURRENCY &&
            project.data.workspaceId === env.PROLIFIC_WORKSPACE_ID,
          currencyCode: balance.data.currencyCode,
          availableBalanceCents: balance.data.availableBalanceCents,
        };
      } catch {
        prolific = { ready: false, error: "Provider check unavailable" };
      }
    }
    return jsonNoStore({
      ok: true,
      eventAccess,
      services: {
        database,
        gemini: Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL),
        prolific,
        openaiFallback: Boolean(env.OPENAI_API_KEY && env.OPENAI_FALLBACK_MODEL),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

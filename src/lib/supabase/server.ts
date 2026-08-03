import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireLiveConfig } from "@/lib/env";

let serviceClient: SupabaseClient | undefined;

export function getServiceSupabase(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const env = requireLiveConfig(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  serviceClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "surveyor-demo/server" } },
  });
  return serviceClient;
}

export function resetSupabaseForTests() {
  serviceClient = undefined;
}

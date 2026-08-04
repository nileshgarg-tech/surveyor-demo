import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { getPublicStudy, publicStudyResponse } from "@/lib/data";
import { StudyDashboard } from "@/components/study-dashboard";
import { EVENT_COOKIE } from "@/lib/security/auth";
import { verifySession } from "@/lib/security/crypto";
import { requireSecret } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function StudyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const study = await loadStudy(id);
  return <StudyDashboard initialStudy={study} />;
}

async function loadStudy(id: string) {
  try {
    const rawStudy = await getPublicStudy(id);
    const canView = await checkCanView(id);
    return publicStudyResponse(rawStudy, canView);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

async function checkCanView(studyId: string): Promise<boolean> {
  try {
    const token = (await cookies()).get(EVENT_COOKIE)?.value;
    if (!token) return false;
    const payload = verifySession(token, "event", requireSecret("SESSION_SIGNING_SECRET"));
    const supabase = getServiceSupabase();
    const [{ data: session }, { data: study }] = await Promise.all([
      supabase.from("event_sessions").select("expires_at,revoked_at").eq("id", payload.sessionId).maybeSingle(),
      supabase.from("studies").select("id, event_session_id").eq("id", studyId).maybeSingle(),
    ]);
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now() || !study) {
      return false;
    }
    if (study.event_session_id !== payload.sessionId) {
      await supabase.from("studies").update({ event_session_id: payload.sessionId }).eq("id", studyId);
    }
    return true;
  } catch {
    return false;
  }
}

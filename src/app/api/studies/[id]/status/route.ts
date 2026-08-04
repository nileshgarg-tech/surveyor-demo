import { getPublicStudy, publicStudyResponse } from "@/lib/data";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserRead } from "@/lib/route-guard";
import { readEventAuthority, setEventCookie } from "@/lib/security/auth";
import { syncRecruitmentStatus } from "@/lib/services/collection";
import { getServiceSupabase } from "@/lib/supabase/server";

import { maybeStartReport } from "@/lib/services/reporting";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const authority = await readEventAuthority(request);
    await guardBrowserRead(request, "status", authority?.sessionId);
    await syncRecruitmentStatus(id);
    let study = await getPublicStudy(id);
    if (study.status === "ready_to_report" || study.status === "reporting") {
      void maybeStartReport(id).catch(() => undefined);
      study = await getPublicStudy(id);
    }
    const canViewResponses = authority ? await controlsStudy(id, authority.sessionId) : false;
    const canFinish = Boolean(
      canViewResponses &&
      study.status === "collecting" &&
      study.manualFinishAt === null &&
      study.responseCount >= 3 &&
      study.launchConfirmedAt &&
      Date.parse(study.launchConfirmedAt) <= Date.now() - 2 * 60_000,
    );
    const response = jsonNoStore({
      study: publicStudyResponse(study, canViewResponses),
      canFinish,
      canViewResponses,
    });
    if (authority?.token) {
      setEventCookie(response, authority.token, authority.expiresAt);
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

async function controlsStudy(studyId: string, eventSessionId: string): Promise<boolean> {
  const supabase = getServiceSupabase();
  const { data: study } = await supabase
    .from("studies")
    .select("id, event_session_id")
    .eq("id", studyId)
    .maybeSingle();
  if (!study) return false;
  if (study.event_session_id === eventSessionId) return true;

  const { data: currentSession } = await supabase
    .from("event_sessions")
    .select("id, expires_at, revoked_at")
    .eq("id", eventSessionId)
    .maybeSingle();

  if (currentSession && !currentSession.revoked_at && Date.parse(String(currentSession.expires_at)) > Date.now()) {
    await supabase.from("studies").update({ event_session_id: eventSessionId }).eq("id", studyId);
    return true;
  }
  return false;
}

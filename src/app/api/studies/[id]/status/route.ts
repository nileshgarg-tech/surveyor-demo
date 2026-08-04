import { getPublicStudy, publicStudyResponse } from "@/lib/data";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { guardBrowserRead } from "@/lib/route-guard";
import { readEventAuthority } from "@/lib/security/auth";
import { syncRecruitmentStatus } from "@/lib/services/collection";
import { getServiceSupabase } from "@/lib/supabase/server";

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
    const study = await getPublicStudy(id);
    const canViewResponses = authority ? await controlsStudy(id, authority.sessionId) : false;
    const canFinish = Boolean(
      canViewResponses &&
      study.status === "collecting" &&
      study.manualFinishAt === null &&
      study.responseCount >= 3 &&
      study.launchConfirmedAt &&
      Date.parse(study.launchConfirmedAt) <= Date.now() - 2 * 60_000,
    );
    return jsonNoStore({
      study: publicStudyResponse(study, canViewResponses),
      canFinish,
      canViewResponses,
    });
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

  if (study.event_session_id) {
    const { data: oldSession } = await supabase
      .from("event_sessions")
      .select("expires_at, revoked_at")
      .eq("id", study.event_session_id)
      .maybeSingle();
    if (!oldSession || oldSession.revoked_at || Date.parse(String(oldSession.expires_at)) <= Date.now()) {
      await supabase.from("studies").update({ event_session_id: eventSessionId }).eq("id", studyId);
      return true;
    }
  }
  return false;
}

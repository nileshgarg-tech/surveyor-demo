import { getEnv } from "@/lib/env";
import { errorResponse, jsonNoStore } from "@/lib/http";
import { assertCronAuthorization } from "@/lib/route-guard";
import { syncRecruitingStudies } from "@/lib/services/collection";
import { stopFinishedStudies } from "@/lib/services/finish";
import { reconcileStaleLaunches } from "@/lib/services/recovery";
import { recoverAndRunReports } from "@/lib/services/reporting";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: import("next/server").NextRequest) {
  try {
    assertCronAuthorization(request);
    const limit = getEnv().RECOVERY_BATCH_SIZE;
    const launches = await reconcileStaleLaunches(limit);
    const reports = await recoverAndRunReports(limit);
    const recruiting = await syncRecruitingStudies(limit);
    const stopped = await stopFinishedStudies(limit);
    return jsonNoStore({ ok: true, launches, reports, recruiting, stopped });
  } catch (error) {
    return errorResponse(error);
  }
}

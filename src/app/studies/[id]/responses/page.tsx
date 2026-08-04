import Link from "next/link";
import { cookies } from "next/headers";
import { EVENT_COOKIE } from "@/lib/security/auth";
import { verifySession } from "@/lib/security/crypto";
import { requireSecret } from "@/lib/env";
import { getSafeIndividualResponses, getInternalStudy } from "@/lib/data";
import { surveySpecSchema } from "@/lib/domain/schemas";
import { getServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ResponsesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authorized = await hasStudyAccess(id);
  if (!authorized) {
    return (
      <main className="shell"><section className="workspace access-required"><div><p className="eyebrow">Private response details</p><h1>Event access required</h1><p>Open this page from the same browser session that launched the study.</p><Link className="secondary-button" href={`/studies/${id}`}>Back to report</Link></div></section></main>
    );
  }
  const study = await getInternalStudy(id);
  const survey = surveySpecSchema.parse(study.survey_spec);
  const responses = await getSafeIndividualResponses(id);
  return (
    <main className="shell responses-shell">
      <header className="brandbar"><Link className="brand" href={`/studies/${id}`}>← Report</Link><span className="report-badge">{responses.length} completed</span></header>
      <section className="workspace responses-workspace">
        <header><p className="eyebrow">Anonymous response detail</p><h1>Individual responses</h1><p>Participant identities and Prolific references are intentionally hidden.</p></header>
        <div className="response-list">
          {responses.map((response) => (
            <article key={response.participantNumber} className="response-card">
              <div className="response-card-head"><h2>Participant {response.participantNumber}</h2><time dateTime={response.submittedAt}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(response.submittedAt))}</time></div>
              <dl>{survey.questions.map((question) => <div key={question.ref}><dt>{question.title}</dt><dd>{String(response.answers[question.ref] ?? "N/A")}</dd></div>)}</dl>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

async function hasStudyAccess(studyId: string): Promise<boolean> {
  try {
    const token = (await cookies()).get(EVENT_COOKIE)?.value;
    if (!token) return false;
    const payload = verifySession(token, "event", requireSecret("SESSION_SIGNING_SECRET"));
    const [{ data: session }, { data: study }] = await Promise.all([
      getServiceSupabase().from("event_sessions").select("expires_at,revoked_at").eq("id", payload.sessionId).maybeSingle(),
      getServiceSupabase().from("studies").select("id, event_session_id").eq("id", studyId).eq("event_session_id", payload.sessionId).maybeSingle(),
    ]);
    if (session && !session.revoked_at && Date.parse(session.expires_at) > Date.now() && study) {
      return true;
    }
    const { data: rawStudy } = await getServiceSupabase().from("studies").select("event_session_id").eq("id", studyId).maybeSingle();
    if (session && !session.revoked_at && Date.parse(session.expires_at) > Date.now() && rawStudy) {
      await getServiceSupabase().from("studies").update({ event_session_id: payload.sessionId }).eq("id", studyId);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

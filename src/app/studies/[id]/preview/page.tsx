import Link from "next/link";
import { getInternalStudy } from "@/lib/data";
import { surveySpecSchema } from "@/lib/domain/schemas";
import { ParticipantSurvey } from "@/components/participant-survey";

export const dynamic = "force-dynamic";

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rawStudy = await getInternalStudy(id);
  const survey = surveySpecSchema.parse(rawStudy.survey_spec);

  const initialState = {
    phase: "survey" as const,
    survey,
    retentionText: "Responses are retained for demonstration purposes only.",
    contactEmail: "research@surveyor-demo.app",
  };

  return (
    <main className="shell responses-shell">
      <header className="brandbar">
        <Link className="brand" href={`/studies/${id}`}>← Back to study</Link>
        <span className="report-badge" style={{ background: "var(--color-primary-tint, #eef7f2)", color: "var(--color-primary, #005a36)" }}>
          Unfilled Participant Survey Preview
        </span>
      </header>
      <section className="workspace responses-workspace" style={{ maxWidth: 840, margin: "0 auto" }}>
        <header>
          <p className="eyebrow">Participant Experience</p>
          <h1>Unfilled survey preview</h1>
          <p>This is the exact interactive survey form paid Prolific participants will see.</p>
        </header>
        <ParticipantSurvey studyId={id} initialState={initialState} initialIssue={null} />
      </section>
    </main>
  );
}

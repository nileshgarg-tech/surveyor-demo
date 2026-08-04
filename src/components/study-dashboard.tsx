"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicStudy } from "@/lib/data";

type StatusPayload = {
  study: PublicStudy;
  canFinish: boolean;
  canViewResponses: boolean;
};

export function StudyDashboard({ initialStudy }: { initialStudy: PublicStudy }) {
  const router = useRouter();
  const [study, setStudy] = useState(initialStudy);
  const [canFinish, setCanFinish] = useState(false);
  const [canViewResponses, setCanViewResponses] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const recoveryRequested = useRef(false);
  const reportRequested = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/studies/${study.id}/status`, { cache: "no-store" });
      const payload = (await response.json()) as StatusPayload & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Progress is temporarily unavailable.");
      setStudy(payload.study);
      setCanFinish(payload.canFinish);
      setCanViewResponses(payload.canViewResponses);
      setError(null);
      if (payload.study.staleOperation && !recoveryRequested.current) {
        recoveryRequested.current = true;
        void mutate(`/api/studies/${study.id}/reconcile`).finally(() => {
          recoveryRequested.current = false;
        });
      }
      if (payload.study.status === "ready_to_report" && !reportRequested.current) {
        reportRequested.current = true;
        void mutate(`/api/studies/${study.id}/report`).finally(() => {
          reportRequested.current = false;
        });
      }
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : "Progress is temporarily unavailable.");
    }
  }, [study.id]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    if (study.status === "complete" && study.report) {
      return () => window.clearTimeout(initialRefresh);
    }
    const interval = window.setInterval(() => void refresh(), 4_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [refresh, study.report, study.status]);

  async function finish() {
    setError(null);
    try {
      await mutate(`/api/studies/${study.id}/finish`);
      await refresh();
    } catch (finishError) {
      setError(finishError instanceof Error ? finishError.message : "Collection could not be finished.");
    }
  }

  async function retryReport() {
    setError(null);
    try {
      await mutate(`/api/studies/${study.id}/report`);
      await refresh();
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "Report generation could not restart.");
    }
  }

  async function deleteCurrentStudy() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/studies/${study.id}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? "Study could not be deleted.");
      router.push("/studies");
    } catch (delError) {
      setError(delError instanceof Error ? delError.message : "Study could not be deleted.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (study.report) {
    return (
      <ReportView
        study={study}
        canViewResponses={canViewResponses}
        onDelete={deleteCurrentStudy}
        deleting={deleting}
      />
    );
  }

  const progress = Math.min(100, Math.round((study.responseCount / study.participantCount) * 100));
  const stage = collectionStage(study);
  return (
    <main className="shell collection-shell">
      <header className="brandbar">
        <Link className="brand" href="/"><span className="brandmark" aria-hidden="true"><i /><i /><i /></span>Surveyor</Link>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Link className="secondary-button" href="/studies" style={{ padding: "6px 12px", fontSize: "12px" }}>
            All Studies
          </Link>
          <Link className="secondary-button" href="/?new=1" style={{ padding: "6px 12px", fontSize: "12px" }}>
            + New Study
          </Link>
          <span className="live-pill"><i aria-hidden="true" /> Live study</span>
        </div>
      </header>
      <section className="workspace collection-workspace">
        <div className="collection-panel">
          <div className="collection-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}>
            <div><strong>{study.responseCount}</strong><span>of {study.participantCount}</span></div>
          </div>
          <div className="collection-copy" aria-live="polite">
            <p className="eyebrow">{stage.eyebrow}</p>
            <h1>{stage.title}</h1>
            <p className="lede">{stage.description}</p>
            <div className="study-facts">
              <span>{study.targeting.recruitedAudience}</span><span>{study.estimatedMinutes} minutes</span><span>{study.survey.questions.length} questions</span>
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginTop: "24px" }}>
              {canFinish ? <button className="secondary-button" style={{ marginTop: 0 }} onClick={() => void finish()}>Finish with current responses</button> : null}
              {study.status === "blocked" ? <button className="secondary-button" style={{ marginTop: 0 }} onClick={() => void retryReport()}>Retry report</button> : null}
              {confirmDelete ? (
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button
                    className="secondary-button"
                    style={{ background: "var(--red)", color: "white", borderColor: "var(--red)", marginTop: 0 }}
                    disabled={deleting}
                    onClick={() => void deleteCurrentStudy()}
                  >
                    {deleting ? "Deleting…" : "Confirm Delete"}
                  </button>
                  <button
                    className="secondary-button"
                    style={{ marginTop: 0 }}
                    disabled={deleting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="secondary-button"
                  style={{ color: "var(--red)", borderColor: "#f2cfce", marginTop: 0 }}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete study
                </button>
              )}
            </div>
            {error ? <p className="error-copy" role="alert">{error}</p> : null}
          </div>
        </div>
        <div className="stage-strip">
          {([
            ["finding", "Finding participants"],
            ["responses", "Responses received"],
            ["report", "Preparing report"],
            ["ready", "Report ready"],
          ] as const).map(([key, label]) => <span key={key} className={stage.key === key ? "active" : stage.passed.includes(key) ? "done" : ""}>{label}</span>)}
        </div>
      </section>
    </main>
  );
}

function ReportView({
  study,
  canViewResponses,
  onDelete,
  deleting,
}: {
  study: PublicStudy;
  canViewResponses: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const report = study.report;
  if (!report) return null;
  return (
    <main className="shell report-shell">
      <header className="brandbar">
        <Link className="brand" href="/"><span className="brandmark" aria-hidden="true"><i /><i /><i /></span>Surveyor</Link>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Link className="secondary-button" href="/studies" style={{ padding: "6px 12px", fontSize: "12px" }}>
            All Studies
          </Link>
          <Link className="secondary-button" href="/?new=1" style={{ padding: "6px 12px", fontSize: "12px" }}>
            + New Study
          </Link>
          <span className="report-badge">{report.sampleSize} responses{report.completionReason === "manual" ? " · partial sample" : ""}</span>
        </div>
      </header>
      <article className="workspace report-workspace">
        <header className="report-hero">
          <p className="eyebrow">What the group said</p>
          <h1>{report.narrative.headline}</h1>
          <p>{report.narrative.summary}</p>
        </header>
        <div className="chart-grid">
          {report.aggregates.questions.map((question) => (
            <section className="chart-card" key={question.ref}>
              <span className="section-label">{question.validTotal} valid answers</span>
              <h2>{question.title}</h2>
              <div className="bars">
                {question.options.map((option) => (
                  <div className="bar-row" key={option.value}>
                    <div className="bar-label"><span>{option.value}</span><strong>{option.percentage}%</strong></div>
                    <div className="bar-track" aria-label={`${option.value}: ${option.count} of ${question.validTotal}, ${option.percentage}%`}>
                      <i style={{ width: `${option.percentage}%` }} />
                    </div>
                    <small>{option.count} {option.count === 1 ? "person" : "people"}</small>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="findings-grid">
          <section><span className="section-label">Findings</span><ul>{report.narrative.findings.map((item) => <li key={item}>{item}</li>)}</ul></section>
          <section><span className="section-label">What this could mean</span><ul>{report.narrative.implications.map((item) => <li key={item}>{item}</li>)}</ul></section>
          <section className="limitations"><span className="section-label">Keep in mind</span><ul>{report.narrative.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section>
        </div>
        <footer className="report-footer">
          <p>Observed sample only · Directional, not a population estimate</p>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            {canViewResponses ? <Link className="secondary-button" href={`/studies/${study.id}/responses`}>View individual responses</Link> : null}
            {confirmDelete ? (
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  className="secondary-button"
                  style={{ background: "var(--red)", color: "white", borderColor: "var(--red)" }}
                  disabled={deleting}
                  onClick={onDelete}
                >
                  {deleting ? "Deleting…" : "Confirm Delete"}
                </button>
                <button
                  className="secondary-button"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="secondary-button"
                style={{ color: "var(--red)", borderColor: "#f2cfce" }}
                onClick={() => setConfirmDelete(true)}
              >
                Delete study
              </button>
            )}
          </div>
        </footer>
      </article>
    </main>
  );
}

function collectionStage(study: PublicStudy) {
  if (study.status === "ready_to_report" || study.status === "reporting" || study.status === "blocked") {
    return { key: "report", passed: ["finding", "responses"], eyebrow: "Preparing report", title: "Turning responses into a clear readout", description: "Counts are calculated in code; AI only helps explain the observed patterns." };
  }
  if (study.responseCount > 0) {
    return { key: "responses", passed: ["finding"], eyebrow: "Collection in progress", title: `${study.responseCount} of ${study.participantCount} responses received`, description: "This page reflects stored completions and updates every few seconds." };
  }
  return { key: "finding", passed: [], eyebrow: "Collection in progress", title: "Finding participants", description: "The study is live on Prolific. Responses will appear here as valid completions arrive." };
}

async function mutate(url: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
    cache: "no-store",
  });
  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "Request failed.");
  return body;
}

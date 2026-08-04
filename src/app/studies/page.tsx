"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublicStudySummary } from "@/lib/data";

export default function StudiesListPage() {
  const [studies, setStudies] = useState<PublicStudySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/studies", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ studies?: PublicStudySummary[]; error?: { message?: string } }>)
      .then((data) => {
        if (!active) return;
        if (data.error) {
          setError(data.error.message ?? "Failed to load studies list.");
        } else {
          setStudies(data.studies ?? []);
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load studies list.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function deleteStudy(id: string) {
    try {
      setDeletingId(id);
      setError(null);
      const res = await fetch(`/api/studies/${id}`, { method: "DELETE" });
      const data = (await res.json()) as { deleted?: boolean; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? "Failed to delete study.");

      setStudies((prev) => prev.filter((s) => s.id !== id));
      setConfirmingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete study from Supabase.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <main className="shell">
      <header className="brandbar">
        <Link className="brand" href="/" aria-label="Surveyor home">
          <span className="brandmark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Surveyor
        </Link>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <Link className="secondary-button" href="/studies">
            All Studies ({studies.length})
          </Link>
          <Link className="primary-button" href="/?new=1" style={{ padding: "10px 18px", fontSize: "14px" }}>
            + New Study
          </Link>
        </div>
      </header>

      <section className="workspace" style={{ display: "block", padding: "clamp(32px, 5vw, 68px)" }}>
        <div style={{ maxWidth: "840px", marginBottom: "36px" }}>
          <p className="eyebrow">Study Repository</p>
          <h1 style={{ fontSize: "clamp(36px, 5vw, 62px)" }}>All Studies</h1>
          <p className="lede" style={{ margin: "14px 0 0" }}>
            View live collection status, access results by Study ID, or manage and delete past studies.
          </p>
        </div>

        {error ? (
          <div className="error-banner" role="alert" style={{ marginBottom: "24px" }}>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div style={{ padding: "60px 20px", textAlign: "center", color: "var(--muted)" }}>
            Loading studies list...
          </div>
        ) : studies.length === 0 ? (
          <div
            style={{
              padding: "60px 20px",
              textAlign: "center",
              border: "1px dashed var(--line)",
              borderRadius: "18px",
              background: "#f9fbfb",
            }}
          >
            <h2 style={{ fontFamily: "Georgia, serif", fontWeight: 500, margin: "0 0 10px" }}>
              No studies created yet
            </h2>
            <p style={{ color: "var(--muted)", margin: "0 0 24px" }}>
              Start by describing what you want to learn from real participants.
            </p>
            <Link className="primary-button" href="/?new=1">
              + Start your first study →
            </Link>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: "20px",
            }}
          >
            {studies.map((study) => {
              const isConfirming = confirmingId === study.id;
              const isDeleting = deletingId === study.id;
              return (
                <article
                  key={study.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "18px",
                    padding: "24px",
                    background: "white",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "16px",
                    boxShadow: "0 4px 14px rgba(0,0,0,0.03)",
                    opacity: isDeleting ? 0.4 : 1,
                    transition: "opacity 0.2s ease",
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        marginBottom: "12px",
                      }}
                    >
                      <span
                        className={`match-badge match-${
                          study.status === "complete"
                            ? "exact"
                            : study.status === "blocked" ||
                              study.status === "abandoned" ||
                              study.status === "cancelled"
                            ? "unsupported"
                            : "proxy"
                        }`}
                        style={{ fontSize: "10px" }}
                      >
                        {study.status.toUpperCase()}
                      </span>
                      <time style={{ color: "var(--muted)", fontSize: "11px" }}>
                        {new Date(study.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </time>
                    </div>
                    <h2
                      style={{
                        fontSize: "18px",
                        lineHeight: "1.35",
                        margin: "0 0 8px",
                        fontFamily: "Georgia, serif",
                      }}
                    >
                      {study.title}
                    </h2>
                    <p style={{ color: "var(--muted)", fontSize: "13px", margin: "0 0 12px", lineHeight: "1.4" }}>
                      Audience: {study.targetAudience}
                    </p>
                    <p style={{ fontSize: "12px", color: "var(--ink)", margin: 0 }}>
                      <strong>{study.participantCount}</strong> participants requested
                    </p>
                  </div>

                  {isConfirming ? (
                    <div
                      style={{
                        paddingTop: "14px",
                        borderTop: "1px solid #fcebea",
                        background: "#fff5f5",
                        borderRadius: "12px",
                        padding: "12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                      }}
                    >
                      <span style={{ fontSize: "12px", color: "var(--red)", fontWeight: 700 }}>
                        Delete this study from Supabase?
                      </span>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={() => void deleteStudy(study.id)}
                          style={{
                            background: "var(--red)",
                            color: "white",
                            border: 0,
                            borderRadius: "999px",
                            padding: "6px 14px",
                            fontSize: "12px",
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          {isDeleting ? "Deleting…" : "Yes, Delete"}
                        </button>
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={() => setConfirmingId(null)}
                          style={{
                            background: "white",
                            color: "var(--ink)",
                            border: "1px solid var(--line)",
                            borderRadius: "999px",
                            padding: "6px 12px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        paddingTop: "14px",
                        borderTop: "1px solid #edf2f0",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                      }}
                    >
                      <code style={{ fontSize: "11px", color: "var(--muted)" }}>ID: {study.id.slice(0, 8)}…</code>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={() => setConfirmingId(study.id)}
                          style={{
                            background: "transparent",
                            color: "var(--red)",
                            border: "1px solid #f2cfce",
                            borderRadius: "999px",
                            padding: "6px 10px",
                            fontSize: "11px",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                          title="Delete study"
                        >
                          Delete
                        </button>
                        <Link
                          className="secondary-button"
                          href={`/studies/${study.id}`}
                          style={{ fontSize: "12px", padding: "6px 12px" }}
                        >
                          View →
                        </Link>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="footer-note">Real people · Clear safeguards · Plain-English findings</footer>
    </main>
  );
}

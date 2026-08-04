import Link from "next/link";
import { getPublicStudiesList, type PublicStudySummary } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function StudiesListPage() {
  let studies: PublicStudySummary[] = [];
  let loadError: string | null = null;

  try {
    studies = await getPublicStudiesList();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load studies list.";
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
            View live collection status, access results by Study ID, or launch a new opinion study.
          </p>
        </div>

        {loadError ? (
          <div className="error-banner" role="alert">
            <span>{loadError}</span>
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
            {studies.map((study) => (
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
                          : study.status === "blocked" || study.status === "abandoned" || study.status === "cancelled"
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

                <div
                  style={{
                    paddingTop: "14px",
                    borderTop: "1px solid #edf2f0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <code style={{ fontSize: "11px", color: "var(--muted)" }}>ID: {study.id.slice(0, 8)}…</code>
                  <Link
                    className="secondary-button"
                    href={`/studies/${study.id}`}
                    style={{ fontSize: "12px", padding: "6px 12px" }}
                  >
                    View study →
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <footer className="footer-note">Real people · Clear safeguards · Plain-English findings</footer>
    </main>
  );
}

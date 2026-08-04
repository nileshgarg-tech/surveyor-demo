"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ApiError = { error?: { message?: string; retryable?: boolean } };
type IntakeResult =
  | { kind: "clarify"; question: string; missing: string }
  | { kind: "insufficient"; explanation: string }
  | {
      kind: "ready";
      brief: { title: string; researchGoal: string; targetAudience: string; context: string };
      survey: Survey;
      audienceCriteria: string[];
      unsupportedBooleanLogic: boolean;
    };

type Survey = {
  title: string;
  intro: string;
  estimatedMinutes: number;
  questions: Array<{
    ref: string;
    type: "multiple_choice" | "opinion_scale" | "yes_no" | "short_text";
    title: string;
    description?: string;
    choices?: string[];
    scale?: { min: number; max: number; leftLabel: string; rightLabel: string };
  }>;
};

type Preview = {
  id: string;
  brief: { title: string; targetAudience: string; researchGoal: string; context: string };
  survey: Survey;
  targeting: {
    status: "exact" | "proxy" | "unsupported";
    requestedAudience: string;
    recruitedAudience: string;
    proxies: Array<{ requested: string; closestSupported: string; limitation: string }>;
    unsupportedCriteria: string[];
    availability: { reportedCount: number; privacyCensoredBelow25: boolean };
  };
  participantCount: 5 | 10 | 20;
  participantCostOptions: Array<{
    participants: 5 | 10 | 20;
    totalCents: number | null;
    enabled: boolean;
    error?: string;
  }>;
  estimatedMinutes: number;
  rewardCents: number;
  authoritativeTotalCents: number | null;
  currencyCode: string | null;
  proxyAccepted: boolean;
};

type ConversationMessage = { role: "user" | "assistant"; content: string };
type Phase = "prompt" | "intake" | "design" | "preview" | "launch" | "error";
type RestorePayload = {
  state: {
    messages: ConversationMessage[];
    userMessageCount: number;
    status: "open" | "processing" | "ready" | "insufficient" | "consumed";
  } | null;
  study: Preview | null;
};

export function SurveyorApp() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("prompt");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [userMessageCount, setUserMessageCount] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventAccess, setEventAccess] = useState<"checking" | "granted" | "missing">("checking");
  const [updatingCount, setUpdatingCount] = useState(false);
  const booted = useRef(false);


  const restorePersistedIntake = useCallback(async function restorePersistedIntake(): Promise<void> {
    try {
      const payload = await api<RestorePayload>("/api/intake/respond", {
        action: "restore",
        requestId: crypto.randomUUID(),
      });
      if (!payload.state) return;
      if (payload.study) {
        setPreview(payload.study);
        setMessages([]);
        setUserMessageCount(0);
        setPhase("prompt");
        return;
      }
      if (payload.state.status === "ready" || payload.state.status === "consumed") {
        setPhase("design");
        const designed = await api<{ study: Preview }>("/api/studies/from-intake", {
          participantCount: 10,
          requestId: crypto.randomUUID(),
        });
        setPreview(designed.study);
        setMessages([]);
        setUserMessageCount(0);
        setPhase("prompt");
        return;
      }
      setMessages(payload.state.messages);
      setUserMessageCount(payload.state.userMessageCount);
      if (payload.state.status === "insufficient") {
        const lastAssistant = [...payload.state.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        setError(lastAssistant?.content ?? "This request still needs a critical detail. Please restart.");
        setPhase("error");
        return;
      }
      if (payload.state.status === "processing") {
        setPhase("intake");
        window.setTimeout(() => void restorePersistedIntake(), 2_000);
        return;
      }
      setPhase("prompt");
    } catch (restoreError) {
      setError(messageFromError(restoreError));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const searchParams = new URLSearchParams(window.location.search);
    const forceNew = searchParams.get("new") === "1" || searchParams.get("new") === "true";

    void activateEventLink()
      .then(async (access) => {
        setEventAccess(access);
        if (forceNew) {
          await api("/api/intake/respond", {
            action: "restart",
            requestId: crypto.randomUUID(),
          }).catch(() => {});
          window.history.replaceState(null, "", window.location.pathname);
          setPhase("prompt");
          setMessages([]);
          setUserMessageCount(0);
          setPreview(null);
        } else {
          await restorePersistedIntake();
        }
      })
      .catch(() => setEventAccess("missing"));
  }, [restorePersistedIntake]);

  const sendIntake = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || phase === "intake" || userMessageCount >= 5) return;
      setError(null);
      setPhase("intake");
      if (preview) {
        await api("/api/intake/respond", {
          action: "restart",
          requestId: crypto.randomUUID(),
        }).catch(() => {});
        setPreview(null);
      }
      setMessages((current) => [...current, { role: "user", content: trimmed }]);
      setPrompt("");
      try {
        const payload = await api<{ result: IntakeResult; userMessageCount: number }>(
          "/api/intake/respond",
          { message: trimmed, requestId: crypto.randomUUID() },
        );
        setUserMessageCount(payload.userMessageCount);
        const result = payload.result;
        if (result.kind === "clarify") {
          setMessages((current) => [
            ...current,
            { role: "assistant", content: result.question },
          ]);
          setPhase("prompt");
          return;
        }
        if (result.kind === "insufficient") {
          setMessages((current) => [
            ...current,
            { role: "assistant", content: result.explanation },
          ]);
          setError(result.explanation);
          setPhase("error");
          return;
        }
        setPhase("design");
        const designed = await api<{ study: Preview }>("/api/studies/from-intake", {
          participantCount: 10,
          requestId: crypto.randomUUID(),
        });
        setPreview(designed.study);
        setPhase("preview");
      } catch (requestError) {
        setError(messageFromError(requestError));
        setPhase("error");
      }
    },
    [phase, preview, userMessageCount],
  );

  async function changeParticipantCount(participants: 5 | 10 | 20) {
    if (!preview || updatingCount || participants === preview.participantCount) return;
    setUpdatingCount(true);
    setError(null);
    try {
      const payload = await api<{ study: Preview }>("/api/studies/from-intake", {
        participantCount: participants,
        requestId: crypto.randomUUID(),
      });
      setPreview(payload.study);
    } catch (requestError) {
      setError(messageFromError(requestError));
    } finally {
      setUpdatingCount(false);
    }
  }

  async function acceptProxy() {
    if (!preview) return;
    setError(null);
    try {
      const payload = await api<{ study: Preview }>(`/api/studies/${preview.id}/accept-proxy`, {
        requestId: crypto.randomUUID(),
      });
      setPreview(payload.study);
    } catch (requestError) {
      setError(messageFromError(requestError));
    }
  }

  async function launch() {
    if (!preview || phase === "launch") return;
    if (eventAccess !== "granted") {
      setError("An official event link is required to run a paid survey. You can still design and preview here.");
      return;
    }
    setPhase("launch");
    setError(null);
    try {
      await api(`/api/studies/${preview.id}/launch`, { requestId: crypto.randomUUID() });
      router.push(`/studies/${preview.id}`);
    } catch (requestError) {
      setError(messageFromError(requestError));
      setPhase("preview");
    }
  }

  async function restart() {
    setError(null);
    try {
      await api("/api/intake/respond", {
        action: "restart",
        requestId: crypto.randomUUID(),
      });
      window.location.reload();
    } catch (requestError) {
      setError(messageFromError(requestError));
    }
  }

  const launchDisabled = useMemo(
    () =>
      !preview ||
      preview.targeting.status === "unsupported" ||
      (preview.targeting.status === "proxy" && !preview.proxyAccepted) ||
      preview.authoritativeTotalCents === null ||
      eventAccess !== "granted" ||
      phase === "launch",
    [eventAccess, phase, preview],
  );

  return (
    <main className="shell">
      <header className="brandbar">
        <Link className="brand" href="/" aria-label="Surveyor home" onClick={() => void restart()}>
          <span className="brandmark" aria-hidden="true"><i /><i /><i /></span>
          Surveyor
        </Link>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Link className="secondary-button" href="/studies" style={{ padding: "8px 14px", fontSize: "13px" }}>
            All Studies
          </Link>
          <button
            className="secondary-button"
            onClick={() => void restart()}
            style={{ padding: "8px 14px", fontSize: "13px" }}
          >
            + New Study
          </button>
          <span className={`access-pill access-${eventAccess}`}>
            <span aria-hidden="true" />
            {eventAccess === "checking"
              ? "Checking event access"
              : eventAccess === "granted"
                ? "Event access ready"
                : "Preview mode"}
          </span>
        </div>
      </header>

      <section className={`workspace phase-${phase}`}>
        {phase === "prompt" || phase === "error" ? (
          <PromptPanel
            prompt={prompt}
            setPrompt={setPrompt}
            messages={messages}
            busy={false}
            error={error}
            preview={preview}
            onSubmit={() => void sendIntake(prompt)}
            onResumeDraft={() => setPhase("preview")}
            onRestart={restart}
          />
        ) : null}

        {phase === "intake" || phase === "design" ? <ProgressInstrument phase={phase} /> : null}

        {preview && (phase === "preview" || phase === "launch") ? (
          <PreviewPanel
            preview={preview}
            eventAccess={eventAccess}
            launchDisabled={launchDisabled}
            launching={phase === "launch"}
            updatingCount={updatingCount}
            error={error}
            onCount={changeParticipantCount}
            onAcceptProxy={() => void acceptProxy()}
            onRestart={() => void restart()}
            onLaunch={() => void launch()}
          />
        ) : null}
      </section>

      <footer className="footer-note">Real people · Clear safeguards · Plain-English findings</footer>
    </main>
  );
}

function PromptPanel(props: {
  prompt: string;
  setPrompt: (value: string) => void;
  messages: ConversationMessage[];
  busy: boolean;
  error: string | null;
  preview?: Preview | null;
  onSubmit: () => void;
  onResumeDraft?: () => void;
  onRestart: () => void;
}) {
  const hasConversation = props.messages.length > 0;
  return (
    <div className={`prompt-panel${hasConversation ? " has-conversation" : ""}`}>
      {props.preview ? (
        <div
          style={{
            marginBottom: "28px",
            padding: "16px 20px",
            borderRadius: "16px",
            background: "var(--amber-pale)",
            border: "1px solid #efd7b3",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          <div>
            <span style={{ fontSize: "11px", fontWeight: 800, color: "var(--amber)", textTransform: "uppercase", letterSpacing: ".1em" }}>
              Draft study ready
            </span>
            <h3 style={{ margin: "4px 0 0", fontFamily: "Georgia, serif", fontSize: "18px", fontWeight: 500 }}>
              {props.preview.brief.title}
            </h3>
          </div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button
              className="primary-button"
              type="button"
              style={{ padding: "9px 16px", fontSize: "13px" }}
              onClick={props.onResumeDraft}
            >
              Resume draft →
            </button>
            <button
              className="secondary-button"
              type="button"
              style={{ padding: "9px 14px", fontSize: "13px" }}
              onClick={props.onRestart}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}

      <div className="prompt-copy">
        <p className="eyebrow">Opinion mapper</p>
        <h1>
          {hasConversation
            ? "Let’s sharpen the study."
            : "Tell me what you want to learn and who you want to ask."}
        </h1>
        <p className="lede">
          {hasConversation
            ? "I’ll only interrupt when a missing detail would change the audience or the questions."
            : "Describe it naturally. I’ll infer sensible defaults, shape the questions, and check the live audience."}
        </p>
      </div>

      {hasConversation ? (
        <div className="conversation-thread" aria-live="polite">
          {props.messages.map((message, index) => (
            <article
              className={`conversation-message message-${message.role}`}
              key={`${message.role}-${index}`}
            >
              <span>{message.role === "assistant" ? "Surveyor" : "You"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
      ) : null}

      <form
        className="prompt-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <label htmlFor="research-prompt" className="sr-only">Research request</label>
        <textarea
          id="research-prompt"
          value={props.prompt}
          onChange={(event) => props.setPrompt(event.target.value)}
          placeholder={
            hasConversation
              ? "Reply naturally. One sentence is enough."
              : "For example: Ask US adults whether they prefer a four-day or five-day workweek, why, and how strongly."
          }
          rows={hasConversation ? 3 : 4}
          maxLength={2_000}
          autoFocus
        />
        <div className="form-row">
          <span className="form-hint">
            {hasConversation
              ? "Answer in your own words. I’ll carry the earlier context forward."
              : "Adults only · Usually ready from one complete message"}
          </span>
          <button className="primary-button" type="submit" disabled={props.busy || props.prompt.trim().length < 2}>
            {hasConversation ? "Send reply" : "Shape the study"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
      {props.error ? (
        <div className="error-banner" role="alert">
          <span>{props.error}</span>
          <button onClick={props.onRestart}>Start fresh</button>
        </div>
      ) : null}
    </div>
  );
}

function ProgressInstrument({ phase }: { phase: "intake" | "design" }) {
  const active = phase === "intake" ? 0 : 2;
  const steps = [
    "Understanding your question",
    "Writing three questions",
    "Checking the live Prolific audience",
    "Calculating time and reward",
  ];
  return (
    <div className="progress-panel" aria-live="polite" aria-busy="true">
      <div className="progress-orbit">
        <div className="progress-core">
          <span className="progress-number">{phase === "intake" ? "01" : "02"}</span>
          <strong>{phase === "intake" ? "Understanding" : "Verifying"}</strong>
          <small>Live design in progress</small>
        </div>
      </div>
      <div className="progress-copy">
        <p className="eyebrow">Building a launchable study</p>
        <h1>{phase === "intake" ? "Turning your idea into a clear brief" : "Grounding the audience and economics"}</h1>
        <ol className="instrument-steps">
          {steps.map((step, index) => (
            <li key={step} className={index < active ? "done" : index === active ? "active" : "pending"}>
              <span aria-hidden="true">{index < active ? "✓" : index + 1}</span>{step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function PreviewPanel(props: {
  preview: Preview | import("@/lib/data").PublicStudy;
  eventAccess: "checking" | "granted" | "missing";
  launchDisabled: boolean;
  launching: boolean;
  updatingCount: boolean;
  error: string | null;
  onCount: (count: 5 | 10 | 20) => void;
  onAcceptProxy: () => void;
  onRestart: () => void;
  onLaunch: () => void;
  onUpdatePreview?: (updated: Preview | import("@/lib/data").PublicStudy) => void;
  onDeleteDraft?: () => void;
}) {
  const { preview } = props;
  const smallAudience = preview.targeting.availability.privacyCensoredBelow25;
  const [showRefine, setShowRefine] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const launchLabel = props.launching
    ? "Starting survey…"
    : preview.targeting.status === "unsupported"
      ? "Adjust audience first"
      : "Run survey";

  async function handleRefine(promptText: string) {
    const trimmed = promptText.trim();
    if (!trimmed || refining) return;
    setRefining(true);
    setRefineError(null);
    try {
      const res = await fetch(`/api/studies/${preview.id}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userPrompt: trimmed, requestId: crypto.randomUUID() }),
      });
      const body = (await res.json()) as { study?: import("@/lib/data").PublicStudy; error?: { message?: string } };
      if (!res.ok || !body.study) throw new Error(body.error?.message ?? "Refinement failed.");
      setRefinePrompt("");
      if (props.onUpdatePreview) {
        props.onUpdatePreview(body.study);
      } else {
        window.location.reload();
      }
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : "Draft refinement failed.");
    } finally {
      setRefining(false);
    }
  }

  async function handleDeleteDraft() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/studies/${preview.id}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? "Study draft could not be deleted.");
      window.location.assign("/studies");
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : "Draft deletion failed.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="preview-panel">
      <div className="preview-heading" style={{ flexWrap: "wrap", gap: "16px" }}>
        <div>
          <p className="eyebrow">Survey ready to review</p>
          <h1>{preview.brief.title}</h1>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <span className={`match-badge match-${preview.targeting.status}`}>
            {preview.targeting.status === "exact" ? "Exact audience" : preview.targeting.status === "proxy" ? "Closest match" : "Needs broader audience"}
          </span>
          <Link
            className="secondary-button"
            href={`/studies/${preview.id}/preview`}
            style={{ padding: "8px 14px", fontSize: "13px" }}
          >
            Preview unfilled survey
          </Link>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setShowRefine(!showRefine)}
            style={{ padding: "8px 14px", fontSize: "13px" }}
          >
            {showRefine ? "Close AI Refiner ↑" : "Refine with AI ✨"}
          </button>
          {confirmDelete ? (
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                className="secondary-button"
                style={{ background: "var(--red)", color: "white", borderColor: "var(--red)", padding: "8px 12px", fontSize: "13px" }}
                disabled={deleting}
                onClick={() => void handleDeleteDraft()}
                type="button"
              >
                {deleting ? "Deleting…" : "Confirm Delete"}
              </button>
              <button
                className="secondary-button"
                style={{ padding: "8px 12px", fontSize: "13px" }}
                disabled={deleting}
                onClick={() => setConfirmDelete(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="secondary-button"
              type="button"
              style={{ color: "var(--red)", borderColor: "#f2cfce", padding: "8px 14px", fontSize: "13px" }}
              onClick={() => setConfirmDelete(true)}
            >
              Delete Draft
            </button>
          )}
        </div>
      </div>

      {showRefine ? (
        <div
          className="refine-drawer"
          style={{
            margin: "0 0 24px 0",
            padding: "20px",
            background: "#fafcfb",
            border: "1px solid #dbe8e1",
            borderRadius: "16px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div>
              <span className="eyebrow" style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, color: "var(--color-primary, #005a36)" }}>
                AI Refinement Assistant
              </span>
              <h3 style={{ margin: "2px 0 0", fontSize: "16px", fontFamily: "Georgia, serif", fontWeight: 500 }}>
                Improve survey questions or audience criteria
              </h3>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "14px" }}>
            {[
              "Focus on California residents",
              "Make question 2 more specific",
              "Add a question about monthly budget",
              "Shorten survey duration to 3 minutes",
            ].map((chip) => (
              <button
                key={chip}
                type="button"
                className="secondary-button"
                style={{ padding: "6px 12px", fontSize: "12px", borderRadius: "20px", background: "white" }}
                disabled={refining}
                onClick={() => void handleRefine(chip)}
              >
                + {chip}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRefine(refinePrompt);
            }}
            style={{ display: "flex", gap: "10px" }}
          >
            <input
              type="text"
              className="refine-input"
              value={refinePrompt}
              onChange={(e) => setRefinePrompt(e.target.value)}
              placeholder="Tell AI what to adjust (e.g., 'Target software developers', 'Ask about EV adoption')..."
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: "10px",
                border: "1px solid #d1dfd7",
                fontSize: "14px",
                fontFamily: "inherit",
              }}
              disabled={refining}
            />
            <button
              type="submit"
              className="primary-button"
              style={{ marginTop: 0, padding: "10px 18px", fontSize: "13px" }}
              disabled={refining || refinePrompt.trim().length < 2}
            >
              {refining ? "Refining with AI…" : "Update Study →"}
            </button>
          </form>
          {refineError ? <p className="error-copy" style={{ marginTop: "10px" }}>{refineError}</p> : null}
        </div>
      ) : null}

      <div className="preview-grid">
        <section className="preview-main">
          <div className="audience-card">
            <div className="audience-card-header">
              <span className="section-label">Audience check</span>
              {preview.targeting.status !== "unsupported" ? (
                <span className="availability-note">
                  {smallAudience
                    ? "Small audience"
                    : `${preview.targeting.availability.reportedCount.toLocaleString()} available now`}
                </span>
              ) : null}
            </div>
            <dl>
              <div><dt>You asked for</dt><dd>{preview.targeting.requestedAudience}</dd></div>
              {preview.targeting.status !== "unsupported" ? (
                <div>
                  <dt>{preview.targeting.status === "exact" ? "Prolific match" : "Closest supported match"}</dt>
                  <dd>{preview.targeting.recruitedAudience}</dd>
                </div>
              ) : null}
            </dl>
            {smallAudience && preview.targeting.status !== "unsupported" ? (
              <p className="warning-note">Fewer than 25 participants may currently qualify, so timing is uncertain.</p>
            ) : null}
            {preview.targeting.proxies.map((proxy) => (
              <p className="limitation" key={`${proxy.requested}-${proxy.limitation}`}>{proxy.limitation}</p>
            ))}
            {preview.targeting.status === "unsupported" ? (
              <div className="unsupported-actions">
                <strong>This audience cannot launch yet.</strong>
                <p>Prolific could not represent:</p>
                <ul>
                  {preview.targeting.unsupportedCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
                <button className="secondary-button" onClick={props.onRestart}>Adjust the audience</button>
              </div>
            ) : null}
            {preview.targeting.status === "proxy" && !preview.proxyAccepted ? (
              <button className="secondary-button" onClick={props.onAcceptProxy}>Use this closest match</button>
            ) : null}
            {preview.targeting.status === "proxy" && preview.proxyAccepted ? (
              <p className="accepted-note">✓ Closest audience accepted</p>
            ) : null}
          </div>

          <div className="question-list">
            <div className="section-line"><span className="section-label">Questions</span><span>{preview.survey.questions.length} total</span></div>
            {preview.survey.questions.map((question, index) => (
              <article className="question-row" key={question.ref}>
                <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
                <div><h2>{question.title}</h2><p>{questionTypeLabel(question)}</p></div>
              </article>
            ))}
          </div>
        </section>

        <aside className="run-card">
          <div className="run-card-header">
            <span className="section-label">Run setup</span>
            <strong>{preview.participantCount} participants</strong>
          </div>
          <fieldset disabled={props.updatingCount || preview.targeting.status === "unsupported"}>
            <legend>Choose sample size</legend>
            <div className="participant-options">
              {preview.participantCostOptions.map((option) => (
                <label
                  key={option.participants}
                  className={`${preview.participantCount === option.participants ? "selected" : ""}${!option.enabled ? " disabled" : ""}`}
                >
                  <input
                    type="radio"
                    name="participants"
                    value={option.participants}
                    checked={preview.participantCount === option.participants}
                    disabled={!option.enabled}
                    onChange={() => props.onCount(option.participants)}
                  />
                  <span className="participant-option-main">
                    <strong>{option.participants}</strong>
                    <small>people</small>
                  </span>
                  <span className="participant-option-price">
                    {option.totalCents === null ? "Unavailable" : formatUsd(option.totalCents)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="metric-list">
            <div><span>Survey length</span><strong>{preview.estimatedMinutes} min</strong></div>
            <div><span>Pay per participant</span><strong>{formatUsd(preview.rewardCents)}</strong></div>
            <div className="total">
              <span>Confirmed total</span>
              <strong>{preview.authoritativeTotalCents === null ? "Unavailable" : formatUsd(preview.authoritativeTotalCents)}</strong>
            </div>
          </div>
          <button className="primary-button run-button" onClick={props.onLaunch} disabled={props.launchDisabled}>
            {launchLabel}
          </button>
          <p className="cost-note">
            {preview.targeting.status === "unsupported"
              ? "Fix the audience before any paid action is possible."
              : props.eventAccess === "granted"
                ? "Paid action starts only after server checks pass."
                : "An official event link is required to publish and spend."}
          </p>
          {props.error ? <p className="inline-error" role="alert">{props.error}</p> : null}
        </aside>
      </div>
    </div>
  );
}



async function activateEventLink(): Promise<"granted" | "missing"> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("event");
  if (token) {
    try {
      await api("/api/event/session", { token });
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      return "granted";
    } catch {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      return "missing";
    }
  }
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const body = (await response.json()) as { eventAccess?: boolean; ok?: boolean };
    return body.ok !== false ? "granted" : "missing";
  } catch {
    return "granted";
  }
}

async function api<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await response.text();
  let payload: (T & ApiError) | undefined;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The server is temporarily busy. Please click 'Send reply' to try again.");
  }
  if (!response.ok) throw new Error(payload?.error?.message ?? "Request failed. Please try again.");
  return payload as T;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function questionTypeLabel(question: {
  type: string;
  choices?: string[] | undefined;
  scale?: { min: number; max: number } | undefined;
  description?: string | undefined;
}): string {
  if (question.type === "multiple_choice") return `${question.choices?.length ?? 0} choices`;
  if (question.type === "opinion_scale") return `${question.scale?.min ?? 1}–${question.scale?.max ?? 5} opinion scale`;
  if (question.type === "yes_no") return "Yes or no";
  return `Short response · ${question.description ?? "280 characters max"}`;
}

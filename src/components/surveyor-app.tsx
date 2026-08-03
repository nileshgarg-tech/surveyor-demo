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
      setMessages(payload.state.messages);
      setUserMessageCount(payload.state.userMessageCount);
      if (payload.study) {
        setPreview(payload.study);
        setPhase("preview");
        return;
      }
      if (payload.state.status === "ready" || payload.state.status === "consumed") {
        setPhase("design");
        const designed = await api<{ study: Preview }>("/api/studies/from-intake", {
          participantCount: 10,
          requestId: crypto.randomUUID(),
        });
        setPreview(designed.study);
        setPhase("preview");
        return;
      }
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
    void activateEventLink()
      .then(async (access) => {
        setEventAccess(access);
        await restorePersistedIntake();
      })
      .catch(() => setEventAccess("missing"));
  }, [restorePersistedIntake]);

  const sendIntake = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || phase === "intake" || userMessageCount >= 5) return;
      setError(null);
      setPhase("intake");
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
    [phase, userMessageCount],
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
        <Link className="brand" href="/" aria-label="Surveyor home">
          <span className="brandmark" aria-hidden="true"><i /><i /><i /></span>
          Surveyor
        </Link>
        <span className={`access-pill access-${eventAccess}`}>
          <span aria-hidden="true" />
          {eventAccess === "checking"
            ? "Checking event access"
            : eventAccess === "granted"
              ? "Event access ready"
              : "Preview mode"}
        </span>
      </header>

      <section className={`workspace phase-${phase}`}>
        {!preview && (phase === "prompt" || phase === "error") ? (
          <PromptPanel
            prompt={prompt}
            setPrompt={setPrompt}
            messages={messages}
            messageCount={userMessageCount}
            busy={false}
            error={error}
            onSubmit={() => void sendIntake(prompt)}
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
  messageCount: number;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onRestart: () => void;
}) {
  const latestAssistant = [...props.messages].reverse().find((message) => message.role === "assistant");
  const hasConversation = props.messages.length > 0;
  return (
    <div className="prompt-panel">
      <p className="eyebrow">Ask a group. Get their opinion.</p>
      <h1>{latestAssistant?.content ?? "Whose opinion do you want, and what do you want to ask them?"}</h1>
      <p className="lede">
        {hasConversation
          ? `One detail at a time · ${Math.max(0, 5 - props.messageCount)} intake turns remaining`
          : "Describe the audience and the decision, idea, or question you want to explore."}
      </p>
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
              ? "Add the missing detail…"
              : "For example: Ask remote software workers what makes a meeting feel worth attending."
          }
          rows={4}
          maxLength={2_000}
          autoFocus
        />
        <div className="form-row">
          <span className="form-hint">Adults only · 3 questions by default</span>
          <button className="primary-button" type="submit" disabled={props.busy || props.prompt.trim().length < 2}>
            {hasConversation ? "Continue" : "Design survey"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
      {props.error ? (
        <div className="error-banner" role="alert">
          <span>{props.error}</span>
          {props.messageCount >= 5 ? <button onClick={props.onRestart}>Start over</button> : null}
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

function PreviewPanel(props: {
  preview: Preview;
  eventAccess: "checking" | "granted" | "missing";
  launchDisabled: boolean;
  launching: boolean;
  updatingCount: boolean;
  error: string | null;
  onCount: (count: 5 | 10 | 20) => void;
  onAcceptProxy: () => void;
  onRestart: () => void;
  onLaunch: () => void;
}) {
  const { preview } = props;
  const smallAudience = preview.targeting.availability.privacyCensoredBelow25;
  return (
    <div className="preview-panel">
      <div className="preview-heading">
        <div>
          <p className="eyebrow">Survey ready to review</p>
          <h1>{preview.brief.title}</h1>
        </div>
        <span className={`match-badge match-${preview.targeting.status}`}>
          {preview.targeting.status === "exact" ? "Exact audience" : preview.targeting.status === "proxy" ? "Closest match" : "Needs broader audience"}
        </span>
      </div>

      <div className="preview-grid">
        <section className="preview-main">
          <div className="audience-card">
            <span className="section-label">Audience</span>
            <dl>
              <div><dt>You requested</dt><dd>{preview.targeting.requestedAudience}</dd></div>
              <div><dt>{preview.targeting.status === "exact" ? "Recruiting" : "Closest supported audience"}</dt><dd>{preview.targeting.recruitedAudience}</dd></div>
            </dl>
            {smallAudience ? <p className="warning-note">Small audience; timing is uncertain</p> : null}
            {preview.targeting.proxies.map((proxy) => (
              <p className="limitation" key={`${proxy.requested}-${proxy.limitation}`}>{proxy.limitation}</p>
            ))}
            {preview.targeting.unsupportedCriteria.length > 0 ? (
              <div className="unsupported-actions">
                <p className="warning-note">Unsupported: {preview.targeting.unsupportedCriteria.join(", ")}. Broaden the audience and restart.</p>
                <button className="secondary-button" onClick={props.onRestart}>Broaden audience and restart</button>
              </div>
            ) : null}
            {preview.targeting.status === "proxy" && !preview.proxyAccepted ? (
              <button className="secondary-button" onClick={props.onAcceptProxy}>Accept closest supported audience</button>
            ) : null}
            {preview.targeting.status === "proxy" && preview.proxyAccepted ? <p className="accepted-note">✓ Closest audience accepted</p> : null}
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
          <span className="section-label">Run setup</span>
          <fieldset disabled={props.updatingCount}>
            <legend>Participants</legend>
            <div className="segmented-control">
              {preview.participantCostOptions.map((option) => (
                <label key={option.participants} className={!option.enabled ? "disabled" : ""}>
                  <input
                    type="radio"
                    name="participants"
                    value={option.participants}
                    checked={preview.participantCount === option.participants}
                    disabled={!option.enabled}
                    onChange={() => props.onCount(option.participants)}
                  />
                  <span>{option.participants}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <ul className="option-costs" aria-label="Provider-confirmed participant costs">
            {preview.participantCostOptions.map((option) => (
              <li key={option.participants} className={!option.enabled ? "disabled" : ""}>
                <span>{option.participants} people</span>
                <small>
                  {option.totalCents === null ? "Unavailable" : formatUsd(option.totalCents)}
                  {option.error ? ` · ${option.error}` : ""}
                </small>
              </li>
            ))}
          </ul>
          <div className="metric-list">
            <div><span>Time</span><strong>{preview.estimatedMinutes} min</strong></div>
            <div><span>Reward</span><strong>{formatUsd(preview.rewardCents)} each</strong></div>
            <div className="total"><span>Provider-confirmed total</span><strong>{preview.authoritativeTotalCents === null ? "Unavailable" : formatUsd(preview.authoritativeTotalCents)}</strong></div>
          </div>
          <button className="primary-button run-button" onClick={props.onLaunch} disabled={props.launchDisabled}>
            {props.launching ? "Starting survey…" : "Run survey"}
          </button>
          <p className="cost-note">
            {props.eventAccess === "granted"
              ? "Paid action starts immediately after server checks pass."
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
    const body = (await response.json()) as { eventAccess?: boolean };
    return body.eventAccess ? "granted" : "missing";
  } catch {
    return "missing";
  }
}

async function api<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json()) as T & ApiError;
  if (!response.ok) throw new Error(payload.error?.message ?? "Request failed. Please try again.");
  return payload;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function questionTypeLabel(question: Survey["questions"][number]): string {
  if (question.type === "multiple_choice") return `${question.choices?.length ?? 0} choices`;
  if (question.type === "opinion_scale") return `${question.scale?.min ?? 1}–${question.scale?.max ?? 5} opinion scale`;
  if (question.type === "yes_no") return "Yes or no";
  return "Short response · 280 characters max";
}

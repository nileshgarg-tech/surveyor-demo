"use client";

import { useEffect, useState } from "react";
import type { SurveyAnswers, SurveyQuestion } from "@/lib/domain/schemas";
import type { ParticipantPageState } from "@/lib/services/participants";
import styles from "./participant-survey.module.css";

export type ParticipantValidationIssue = "retry" | "invalid" | "missing";

type SafeMutationResponse = {
  state?: {
    phase: ParticipantPageState["phase"];
    completionUrl?: string;
    completionCode?: string;
  };
  completed?: boolean;
  completionUrl?: string;
  completionCode?: string;
  error?: { message?: string };
};

export function ParticipantSurvey({
  studyId,
  initialState,
  initialIssue,
}: {
  studyId: string;
  initialState: ParticipantPageState | null;
  initialIssue: ParticipantValidationIssue | null;
}) {
  const [state, setState] = useState(initialState);
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [pending, setPending] = useState<"consent" | "decline" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function recordConsent(agreed: boolean) {
    setPending(agreed ? "consent" : "decline");
    setError(null);
    try {
      const payload = await mutate(`/api/surveys/${studyId}/consent`, {
        agreed,
        requestId: crypto.randomUUID(),
      });
      if (!state || !payload.state) throw new Error("Consent could not be confirmed.");
      setState({
        ...state,
        phase: payload.state.phase,
        ...(payload.state.completionUrl
          ? { completionUrl: payload.state.completionUrl }
          : {}),
        ...(payload.state.completionCode
          ? { completionCode: payload.state.completionCode }
          : {}),
      });
    } catch (mutationError) {
      setError(safeErrorMessage(mutationError, "Consent could not be saved. Please try again."));
    } finally {
      setPending(null);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("submit");
    setError(null);
    try {
      const payload = await mutate(`/api/surveys/${studyId}/submit`, {
        answers,
        requestId: crypto.randomUUID(),
      });
      if (!state || !payload.completed || !payload.completionUrl || !payload.completionCode) {
        throw new Error("Completion could not be confirmed.");
      }
      setState({
        ...state,
        phase: "completed",
        completionUrl: payload.completionUrl,
        completionCode: payload.completionCode,
      });
      window.setTimeout(() => window.location.assign(payload.completionUrl as string), 350);
    } catch (mutationError) {
      setError(safeErrorMessage(mutationError, "Your answers could not be submitted. Please try again."));
    } finally {
      setPending(null);
    }
  }

  if (!state) {
    return <IssueView issue={initialIssue ?? "missing"} />;
  }

  if (state.phase === "declined") return <DeclinedView />;
  if (state.phase === "completed") return <CompletedView state={state} />;
  if (state.phase === "issue") return <IssueView issue="invalid" />;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Surveyor
        </span>
        <span className={styles.securePill}>Validated Prolific survey</span>
      </header>

      {state.phase === "consent" ? (
        <section className={styles.card} aria-labelledby="consent-title">
          <p className={styles.eyebrow}>Before you begin</p>
          <h1 id="consent-title">Your choice and privacy</h1>
          <p className={styles.lede}>
            Please review this short consent notice. Participation is voluntary.
          </p>
          <div className={styles.consentGrid}>
            <section>
              <h2>What we collect</h2>
              <p>
                We collect your answers to the opinion questions in this survey. We also store your
                Prolific participant, study, and submission identifiers so we can match your response
                and support payment.
              </p>
            </section>
            <section>
              <h2>How it is used</h2>
              <p>
                Your answers support a live Surveyor demonstration and may appear in anonymous charts
                or response summaries. Your Prolific identifiers are never shown in the report.
              </p>
            </section>
            <section>
              <h2>Retention and questions</h2>
              <p>{state.retentionText}</p>
              <p>
                {state.contactEmail ? (
                  <>
                    Questions or deletion requests: <a href={`mailto:${state.contactEmail}`}>{state.contactEmail}</a>.
                  </>
                ) : (
                  <>For questions or deletion requests, contact the researcher through Prolific messaging.</>
                )}
              </p>
            </section>
            <section>
              <h2>Your choice</h2>
              <p>
                You may decline now and return the submission in Prolific. Choosing not to participate
                will not affect your Prolific account.
              </p>
            </section>
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button
              className={styles.primaryButton}
              disabled={pending !== null}
              onClick={() => void recordConsent(true)}
              type="button"
            >
              {pending === "consent" ? "Saving consent…" : "I agree — start survey"}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={pending !== null}
              onClick={() => void recordConsent(false)}
              type="button"
            >
              {pending === "decline" ? "Saving choice…" : "I do not agree"}
            </button>
          </div>
        </section>
      ) : (
        <section className={`${styles.card} ${styles.surveyCard}`} aria-labelledby="survey-title">
          <p className={styles.eyebrow}>A short opinion survey · {state.survey.estimatedMinutes} minutes</p>
          <h1 id="survey-title">{state.survey.title}</h1>
          <p className={styles.lede}>{state.survey.intro}</p>
          <form onSubmit={(event) => void submit(event)}>
            <div className={styles.questions}>
              {state.survey.questions.map((question, index) => (
                <QuestionField
                  key={question.ref}
                  question={question}
                  number={index + 1}
                  value={answers[question.ref]}
                  onChange={(value) => setAnswers((current) => ({ ...current, [question.ref]: value }))}
                />
              ))}
            </div>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.submitRow}>
              <p>Your answers are checked and saved before Prolific completion.</p>
              <button className={styles.primaryButton} disabled={pending !== null} type="submit">
                {pending === "submit" ? "Submitting securely…" : "Submit answers"}
              </button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}

function QuestionField({
  question,
  number,
  value,
  onChange,
}: {
  question: SurveyQuestion;
  number: number;
  value: string | number | undefined;
  onChange: (value: string | number) => void;
}) {
  const legend = (
    <>
      <span className={styles.questionNumber}>{String(number).padStart(2, "0")}</span>
      <span>{question.title}</span>
    </>
  );

  if (question.type === "short_text") {
    return (
      <fieldset className={styles.question}>
        <legend>{legend}</legend>
        <p className={styles.questionHelp}>{question.description}</p>
        <textarea
          maxLength={280}
          onChange={(event) => onChange(event.target.value)}
          required
          value={typeof value === "string" ? value : ""}
        />
        <small>{typeof value === "string" ? value.length : 0}/280 characters</small>
      </fieldset>
    );
  }

  const options =
    question.type === "multiple_choice"
      ? question.choices.map((choice) => ({ label: choice, value: choice }))
      : question.type === "yes_no"
        ? [
            { label: "Yes", value: "Yes" },
            { label: "No", value: "No" },
          ]
        : Array.from(
            { length: question.scale.max - question.scale.min + 1 },
            (_, index) => question.scale.min + index,
          ).map((scaleValue) => ({ label: String(scaleValue), value: scaleValue }));

  return (
    <fieldset className={styles.question}>
      <legend>{legend}</legend>
      {question.description ? <p className={styles.questionHelp}>{question.description}</p> : null}
      {question.type === "opinion_scale" ? (
        <div className={styles.scaleLabels}>
          <span>{question.scale.leftLabel}</span>
          <span>{question.scale.rightLabel}</span>
        </div>
      ) : null}
      <div className={question.type === "opinion_scale" ? styles.scaleOptions : styles.choiceOptions}>
        {options.map((option, index) => (
          <label key={String(option.value)}>
            <input
              checked={value === option.value}
              name={question.ref}
              onChange={() => onChange(option.value)}
              required={index === 0}
              type="radio"
              value={String(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CompletedView({ state }: { state: ParticipantPageState }) {
  return (
    <main className={styles.page}>
      <section className={`${styles.card} ${styles.centerCard}`}>
        <span className={styles.successMark} aria-hidden="true">✓</span>
        <p className={styles.eyebrow}>Response saved</p>
        <h1>Thank you for sharing your opinion</h1>
        <p className={styles.lede}>
          Your response is complete. Continue to Prolific so your submission can be recorded and paid.
        </p>
        {state.completionUrl && state.completionCode ? (
          <>
            <a className={styles.primaryButton} href={state.completionUrl}>Return to Prolific</a>
            <p className={styles.fallback}>
              If the link does not open, enter completion code <code>{state.completionCode}</code> in Prolific.
            </p>
          </>
        ) : (
          <p className={styles.error} role="alert">The completion link is unavailable. Please contact the researcher through Prolific.</p>
        )}
      </section>
    </main>
  );
}

function DeclinedView() {
  return (
    <main className={styles.page}>
      <section className={`${styles.card} ${styles.centerCard}`}>
        <p className={styles.eyebrow}>Choice saved</p>
        <h1>No survey answers were collected</h1>
        <p className={styles.lede}>
          Please return this submission from your Prolific submissions page. You will not be asked to complete this survey.
        </p>
        <a className={styles.secondaryButton} href="https://app.prolific.com/submissions">Open Prolific submissions</a>
      </section>
    </main>
  );
}

function IssueView({ issue }: { issue: ParticipantValidationIssue }) {
  const copy =
    issue === "retry"
      ? {
          title: "Prolific validation is temporarily unavailable",
          description: "No answers have been collected. Return to Prolific and reopen the survey link to retry.",
        }
      : issue === "invalid"
        ? {
            title: "This submission cannot open the survey",
            description: "The Prolific submission did not match this survey or is no longer collectable. Return to Prolific for guidance.",
          }
        : {
            title: "Open this survey from Prolific",
            description: "A validated Prolific session is required. Return to your Prolific study and use its survey link.",
          };
  return (
    <main className={styles.page}>
      <section className={`${styles.card} ${styles.centerCard}`}>
        <p className={styles.eyebrow}>Survey access</p>
        <h1>{copy.title}</h1>
        <p className={styles.lede}>{copy.description}</p>
        <a className={styles.secondaryButton} href="https://app.prolific.com/submissions">Return to Prolific</a>
      </section>
    </main>
  );
}

async function mutate(url: string, body: Record<string, unknown>): Promise<SafeMutationResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json()) as SafeMutationResponse;
  if (!response.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

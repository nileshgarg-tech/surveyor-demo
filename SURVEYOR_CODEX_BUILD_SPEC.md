# Surveyor — Prolific Demo Build Specification

> This is the complete specification for the stripped poster demo. It is planning context, not build authorization. Reviewing or editing this file never authorizes code, scaffolding, migrations, dependency installation, deployment, or paid API testing. Begin implementation only after the user separately and explicitly says to start building the approved spec.

## 1. Product

Surveyor lets anyone describe whose opinion they want, uses AI to create a short survey, recruits real paid participants through Prolific, and turns the responses into a visual report.

> Ask a group. Get their opinion.

The only required loop is:

```text
Natural-language request
  → research brief
  → supported Prolific audience
  → 3–5 survey questions
  → real paid responses
  → charts and plain-English findings
```

## 2. Priorities

1. A visitor can use the product without instruction.
2. Targeting can never send invented Prolific filters or choices.
3. Paid actions obey hard server-side spend and concurrency limits.
4. Provider calls are idempotent and recoverable.
5. Progress shown in the UI reflects persisted state.
6. Reports are understandable without statistical training.
7. The application remains small enough to build and rehearse quickly.

This is a real paid-participant demo, not an AI simulation.

## 3. Scope

Build:

- One public prompt-first experience.
- A short AI intake conversation.
- Three survey questions by default and five maximum.
- Live, catalog-validated Prolific targeting.
- Honest exact-match or proxy targeting review.
- Compact audience, survey, duration, and cost preview.
- Real Prolific draft creation and publication.
- A small in-app participant survey.
- Automatic Prolific approval for valid completions.
- Live response-count progress.
- Automatic and manually triggerable report generation.
- A visual report and secondary individual-response view.
- Event-link authorization, spend/concurrency limits, rate limits, and idempotency.
- Supabase persistence and Vercel deployment.

Do not build:

- Accounts, Google OAuth, or researcher allowlisting.
- AI-simulated participants.
- Tally or another survey provider.
- A general survey builder.
- A separate Python, FastAPI, Cloud Run, or Cloud Tasks service.
- Email, replication, PDF export, or advanced statistics.
- Arbitrary custom screening or an operations dashboard.
- You.com search/research integration in the core demo.

## 4. Technology

- Strict TypeScript, Next.js App Router, and React.
- Server components, client components, route handlers, and server-only integrations.
- Plain modern CSS with CSS custom properties.
- Supabase Postgres as source of truth.
- Zod for environment, request, model-output, and stored-JSON validation.
- Gemini 3.6 Flash through Google's Gemini API.
- Optional OpenAI fallback for transient Gemini failures.
- Thin typed provider adapters; use an official SDK only when it reduces protocol risk.
- Vitest for domain and integration tests.
- Vercel deployment.

Secrets and provider credentials must never enter client bundles.

## 5. AI provider rules

Pin the operational model:

```dotenv
GEMINI_MODEL=gemini-3.6-flash
```

Never ask a model which provider model or API version exists. Generated prose about model availability is not operational evidence and must never change routing.

At runtime:

1. Validate the configured model through the live models API or a tiny schema-constrained diagnostic request and cache that result.
2. Use the configured model string exactly.
3. Retry timeouts, 429s, and 5xx responses with bounded backoff.
4. Use OpenAI fallback only after configured machine-readable failures such as repeated transient errors or model-not-found.
5. Never switch because generated text claims another model is newer.
6. Validate every model response locally.

Use Gemini's current Interactions API and structured outputs. Do not send deprecated `temperature`, `top_p`, `top_k`, or `candidate_count` fields, do not end a request with a prefilled model turn, and do not let model prose select API parameters. Keep conversation state server-side; if `previous_interaction_id` is used, persist it rather than trusting a client-supplied value.

Use common domain schemas across providers. Web search is unnecessary for short opinion questions. The app must not invent factual context about the group. You.com may be added later but is not a dependency.

## 6. Public event access

There is no signup and no visible PIN. The poster QR contains an event token in the URL fragment:

```text
https://<deployment-domain>/#event=<high-entropy-token>
```

On load:

1. Client detects the fragment.
2. It sends the token once to `POST /api/event/session`.
3. Server compares it with `EVENT_LAUNCH_TOKEN` using timing-safe comparison.
4. Success sets a signed `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
5. Client removes the fragment from browser history.

Anyone scanning or receiving the event link can use the complete application from their device. A visitor who discovers only the base URL may design and preview but cannot publish a paid study. Explain that an official event link is required instead of showing a mysterious error.

The token does not rotate hourly. Rotation is manual. Cookie lifetime defaults to 12 hours. Event access authorizes demo budget usage; it is not user identity.

## 7. Money, concurrency, and abuse controls

Server-enforced defaults:

- Participant choices: 5, 10, or 20.
- Default participants: 10.
- Target compensation: $12 USD/hour.
- Expected Prolific workspace currency: USD.
- Maximum authorized cost per study: $25.
- Maximum authorized event budget: $500.
- Maximum globally recruiting/launching studies: 3.
- Maximum recruiting/launching study per event browser/session: 1.

All money is represented and stored as integer cents. Never use floating-point dollars for authorization decisions.

```text
reward_cents = ceil(estimated_minutes / 60 × 1200)
rough_preview_cents = ceil(participants × reward_cents × 1.333)
authoritative_total_cents = Prolific study-cost-calculator total_cost
```

The local 1.333 academic multiplier is only a fast visual estimate. Before showing a final launchable price—and again inside the launch transaction—call Prolific's study cost calculator. Its `total_cost` includes the workspace's actual fees and VAT and is authoritative for both the $25 and $500 caps. If that check is unavailable, show a retry state and disable launch; never fall back to the rough estimate for authorization.

Also fetch the configured workspace balance during health/pre-launch checks. Require `currency_code=USD` and sufficient `available_balance` for the authoritative cost. A currency mismatch is a configuration error, not a conversion opportunity. The wallet check improves the error message; the local caps remain mandatory.

Enforce Prolific's current minimum compensation and the configured $12/hour rate. Never lower pay or understate duration to fit a cap. At three minutes, rough academic totals are $4 for 5 participants, $8 for 10, and $16 for 20; the UI must display the provider-confirmed total when available. Disable any participant choice whose authoritative total exceeds $25 and explain why.

Budget authorization and concurrency are related but have separate lifecycles:

```text
budget_state: none | reserved | committed | void
slot_state:   none | held | released
```

- `budget_state=reserved`: exact provider-confirmed cost is held locally before create/publish.
- `budget_state=committed`: publishing is confirmed or Prolific reports a state in which participant spend can occur. This amount remains part of the event's lifetime spend even after the study ends.
- `budget_state=void`: reconciliation proves an unpublished study was deleted or no external study was created; subtract its reserved amount.
- `slot_state=held`: launch is unresolved or the study can still recruit.
- `slot_state=released`: Prolific confirms the study cannot recruit, including deleted draft, `PAUSED`, `AWAITING REVIEW`, or `COMPLETED`. Releasing a slot never refunds committed event budget.
- Ambiguous provider results retain the reserved budget and held slot until reconciliation.
- Never release either merely because a timeout elapsed.

Atomically reserve the exact cost and a slot in one Postgres transaction before any provider create/publish action. Lock the singleton control row; revalidate cost freshness, reserved-plus-committed event budget, global held slots, per-session held slots, and study lifecycle; then record exactly one reservation. On confirmed publish, atomically move its amount from reserved to committed while retaining the slot. The event cap always uses reserved plus committed amounts.

Use database-backed rate-limit buckets because serverless instance memory is not shared. Key them by a server-HMAC of event session and/or IP, never raw IP. Browser mutations must be same-origin, JSON-only, and non-CORS; validate `Origin`/`Host` in addition to `SameSite` cookies. Apply conservative limits to intake, launch, status, submission, finish, report, and recovery routes.

## 8. Visitor intake

The landing screen asks:

> Whose opinion do you want, and what do you want to ask them?

The intake agent may receive at most five user messages. Assistant messages do not count.

- The normal target is the initial request plus zero or one clarification.
- Use additional clarifications only when an honest, launchable brief still cannot be produced; five user messages is the absolute fallback cap.
- Ask one short clarification at a time.
- Ask only when goal, context, or audience is materially unclear.
- Become ready as soon as a useful brief exists.
- Do not force five turns.
- Do not fabricate missing critical facts.
- If the fifth message is insufficient, explain what is missing and allow restart.
- Once ready, generate the brief and preview instead of continuing chat.

```ts
type StudyBrief = {
  title: string;          // specific, <= 80 chars
  researchGoal: string;
  targetAudience: string;
  context: string;
};
```

Use three questions by default. AI may choose four or five only when genuinely needed and the economics remain valid.

## 9. Survey contract

Supported types: `multiple_choice`, `opinion_scale`, `yes_no`, and `short_text`.

```ts
type SurveySpec = {
  title: string;
  intro: string;
  estimatedMinutes: 1 | 2 | 3 | 4 | 5;
  questions: SurveyQuestion[]; // 3–5 unique refs
};

type SurveyQuestion = {
  ref: string;
  type: "multiple_choice" | "opinion_scale" | "yes_no" | "short_text";
  title: string;
  description?: string;
  required: true;
  choices?: string[];
  scale?: {
    min: number;
    max: number;
    leftLabel: string;
    rightLabel: string;
  };
};
```

Rules:

- Prefer questions that create clear visual results.
- Include at most one short-text question.
- Limit short text to 280 characters, label it “Do not include names or contact details,” and reject obvious email addresses, phone numbers, and URLs before acceptance.
- Never request direct identifiers.
- Never screen eligibility inside the survey.
- Avoid leading, double-barreled, redundant, or padded questions.
- Closed choices must be understandable and include neutral/other when appropriate.
- Validate types, refs, choices, scales, required fields, and count locally.

AI proposes duration, but the server owns the final estimate. Use this conservative floor and round up:

```text
duration_floor_seconds =
  45 consent/introduction
  + 25 per closed question
  + 75 per short-text question
  + 45 navigation/buffer
estimated_minutes = clamp(ceil(duration_floor_seconds / 60), 1, 5)
```

The submitted estimate is the greater of the AI estimate and this floor. If it exceeds five minutes, shorten the survey honestly or reject the design; never clamp a longer survey down to five. This makes a typical three-closed-question demo three minutes and avoids systematically underpaying participants.

## 10. Prolific targeting router

Targeting is a closed-catalog routing problem, not free-form generation.

Fetch the current Prolific filter catalog with workspace context and detailed metadata. Follow pagination safely and cache successful results briefly. The live response defines the only valid filter IDs, types, bounds, and choice IDs.

Never treat a hardcoded provider ID as authoritative. Curated aliases may identify semantic roles or normalized titles but must resolve against the live catalog.

```text
Requested audience
  → resolve common criteria
  → if needed, search a compact live-catalog index
  → inspect full shortlisted filters
  → exact, proxy, or unsupported result
  → local validation
```

The fast route covers country, age, gender/sex, employment, industry, student status, education, fluent language, political affiliation, and parenthood/relationship status. This is a convenience, not a permanent restriction.

Build a compact index from title, question, category, type, bounds, and choice count. Use deterministic aliases/keyword scoring to shortlist before AI judgment. Give AI exact live details only for shortlisted filters.

AI output references exact live IDs and values. Validate all choices and ranges locally. Unknown IDs/choices, invalid types, and out-of-bound ranges are rejected before draft creation.

Support only logic the simplified Prolific filter schema can represent safely: AND between different criteria, OR among selected values within one criterion, and one valid range per range filter. If the requested boolean logic cannot be represented exactly, mark it proxy or unsupported; never rewrite it silently.

```ts
type TargetingPlan = {
  status: "exact" | "proxy" | "unsupported";
  requestedAudience: string;
  recruitedAudience: string;
  confidence: "high" | "medium" | "low";
  filters: ValidatedProlificFilter[];
  proxies: Array<{
    requested: string;
    closestSupported: string;
    limitation: string;
  }>;
  unsupportedCriteria: string[];
  availability: {
    reportedCount: number;
    privacyCensoredBelow25: boolean;
    checkedAt: string;
  };
};
```

- Exact requires high confidence, no proxy, and no unsupported criterion.
- Any approximation forces proxy regardless of model label.
- A proxy must be the closest defensible group.
- Show “You requested” and “Closest supported audience,” plus limitations.
- Visitor must accept a proxy before launch.
- If no proxy exists, ask the visitor to broaden within remaining intake turns.
- Never silently drop a requirement.
- Never compensate by screening inside the survey.
- After local validation, call Prolific's eligibility-count endpoint with the configured workspace. Its returned `0` means fewer than 25 available, not necessarily zero. Show “Small audience; timing is uncertain” rather than “0 people,” and allow the visitor to accept that warning or broaden the audience.

## 11. Preview and launch UX

There is no operations dashboard or separate approval workflow.

During design, show a central progress circle with truthful messages:

- Understanding your question
- Checking the live Prolific audience
- Writing three questions
- Calculating time and reward

Animation may rotate while a request is pending but must not claim success before evidence is persisted.

The circle expands into one compact preview: title, requested/recruited audience, exact/proxy status, proxy acceptance if needed, questions, participant count, estimated minutes, reward, and estimated total.

The primary CTA is:

> Run survey

Do not put “Spend $X” or “up to $X” in the button. Show cost immediately beside or below it as quiet secondary text. After Run survey, launch immediately if checks pass; do not add another confirmation.

## 12. Prolific launch

The draft includes:

- Public/internal names and concise participant description.
- External Surveyor URL.
- Templates for `PROLIFIC_PID`, `STUDY_ID`, and `SESSION_ID`.
- `prolific_id_option: url_parameters`.
- Participant count, time, reward, and project/workspace context.
- Explicit `maximum_allowed_time = ceil(2 + 2m + 2sqrt(m))`, where `m` is estimated minutes, so the participant window is fair but bounded at Prolific's documented minimum.
- Validated filters only.
- Desktop/mobile compatibility.
- One completion code with automatic-approval action.
- Exact `internal_name: surveyor-demo:<Surveyor UUID>` and the same UUID in the documented string `metadata` field.

Launch sequence:

1. Re-fetch authoritative cost/balance, then atomically reserve exact cents and a slot.
2. Compare-and-set `draft → launching`.
3. Create one Prolific draft.
4. Persist request fingerprint, response, external ID, and `is_ready_to_publish` evidence.
5. Publish with the transition endpoint.
6. Persist launch evidence, move budget from reserved to committed, and move to `collecting` while retaining the slot.

Retries must not create multiple drafts or publish twice. Prolific does not document a create idempotency-key header, so do not invent one. Serialize launch per study with a database lock/compare-and-set and the unique local provider-operation record. After an ambiguous create, paginate the study list for the exact internal name, retrieve any match, and confirm its metadata before adopting it. Zero matches permits a retry only after reconciliation; more than one match blocks automatically rather than guessing. If a provider succeeds and the next database write fails, preserve audit evidence and reconcile rather than repeat blindly.

### Automatic launch recovery and abandonment

Every provider operation runs inside typed `try/catch/finally` handling and records its attempt before the request.

- Failure before sending a provider request: mark `abandoned`, void the budget reservation, and release the slot.
- Definitive provider rejection with no external study created: mark `abandoned`, void the budget reservation, and release the slot.
- Ambiguous timeout/connection loss after request dispatch: mark `reconciling`, retain reserved budget and held slot, and query Prolific by stored ID or exact internal name/metadata.
- Draft exists but publish definitively failed: keep the external ID, remain retryable, and do not create another draft.
- Provider reports `UNPUBLISHED`: publish may be retried once through the normal idempotent action.
- Provider reports `PUBLISHING`, `ACTIVE`, `PAUSED`, `AWAITING REVIEW`, or `COMPLETED`: never publish again; merge provider state locally. Commit the budget once publishing/paid exposure is confirmed and release the slot only for a confirmed non-recruiting state.
- A draft may be abandoned only after Prolific confirms it is unpublished and deletion/cancellation succeeds.
- An active or possibly active study may never be abandoned merely to free a slot.

A launch becomes stale after `STALE_LAUNCH_MINUTES` without a stage update. Stale does not mean failed; it means reconciliation is required.

Reconciliation runs automatically:

1. before reserving any new launch;
2. when a study status response reports a stale operation, through an idempotent reconcile request from the client; and
3. through a protected Vercel cron/internal endpoint that also recovers stale reports.

The cron is required for unattended recovery; page-driven reconciliation only improves latency. Protect it with Vercel's `Authorization: Bearer $CRON_SECRET`, process a bounded batch, and call domain functions directly rather than self-fetching API routes. Recovery actions must be compare-and-set and safe to repeat.

### Provider error policy

- Retry only network failures, timeouts, 429s, and 5xx responses.
- Honor `Retry-After`; otherwise use exponential backoff with jitter and at most `MAX_PROVIDER_RETRIES`.
- Do not automatically retry 400 validation errors, 401 authentication errors, or 403 permission errors.
- Treat 404 according to operation context; never assume it means a create/publish request failed.
- Preserve sanitized request/response metadata and provider request IDs.
- Show a friendly summary in the UI and keep technical details server-side.
- Prolific may limit repeated low-participant launches; handle 429/capacity responses as recoverable rather than starting parallel duplicate launches.

Never claim success without stored provider evidence.

## 13. Participant experience

Route: `/survey/[studyId]`.

Capture all three Prolific identifiers server-side. Validation is mandatory and automatic:

1. Validate identifier formats.
2. Fetch the Prolific submission using `SESSION_ID`.
3. Confirm its study ID and participant ID exactly match the URL values and local study.
4. For new data collection, require Prolific submission status `RESERVED` or `ACTIVE`; after manual finish, also require its provider `started_at` to be no later than the persisted pause cutoff.
5. Issue a short-lived, domain-separated, signed `HttpOnly` participant-session cookie tied to the Surveyor study and all three identifiers.
6. Redirect to the same survey URL without identifier query parameters.

Set `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on participant pages. If Prolific validation is temporarily unavailable, show a retry state and do not collect answers yet. After validation, survey submission trusts only the signed participant session, not raw client-supplied IDs. Never expose another participant's answers.

Revisits are idempotent. If Prolific reports `AWAITING REVIEW` or `APPROVED` and the identifiers match an already completed local response, restore only that participant's completion screen/link; never reopen or overwrite their answers. Other terminal/mismatched statuses show return/support guidance without collecting data.

Obtain consent before data collection. Keep this compact and fixed, not AI-generated. State what opinion data is collected, that it supports a live demo, that Prolific IDs are stored for matching/payment, that answers may appear anonymously, retention/deletion information, contact email, and that participation is voluntary.

Participant continues with:

> I agree — start survey

Record consent/timestamp. A decline receives return-submission instructions.

On survey submit:

1. Verify the signed participant session and consent record.
2. Validate all answers server-side.
3. Insert idempotently by Prolific submission/session ID.
4. Reject a second differing submission for that session.
5. Store structured answers and readable summary.
6. Mark complete.
7. Redirect to `https://app.prolific.com/submissions/complete?cc=<code>`; display a retry link and code as fallback.
8. Trigger completion/report check after storage.

Automatic approval applies only to participants reaching this valid completion path.

## 14. Live collection

After launch, the main page shows persisted stages:

- Finding participants
- Responses received: X of N
- Preparing report
- Report ready

Poll a status endpoint every 3–5 seconds while open. Webhooks are unnecessary because Surveyor receives responses directly. Correctness cannot depend on the page staying open; every submission runs the idempotent completion check.

At target, automatically start one report.

After two minutes and at least three responses, show:

> Finish with current responses

Manual finish is a two-stage provider operation:

1. Compare-and-set one finish request and send Prolific `PAUSE` so no new participant can enter while people already taking part may complete.
2. Only after `PAUSED` is confirmed, persist `manual_finish_at`, release the local recruiting slot, freeze `report_snapshot_at`, and create the partial-sample report.
3. Continue accepting verified Prolific submissions whose provider `started_at` is at or before the pause cutoff.
4. Reconciliation lists submissions; when no pre-pause `RESERVED`/`ACTIVE` submissions remain, or their maximum allowed time has elapsed, send `STOP` and confirm `COMPLETED`/`AWAITING REVIEW` as appropriate.

If pause fails or is ambiguous, record/reconcile it and do not claim collection stopped or release the slot. The report states its frozen sample size; later valid completions are stored and paid but do not silently change an already generated report. Surveyor never resumes a manually finished study.

## 15. Report

Calculate chart data deterministically in application code. AI interprets; it does not calculate exact counts.

For each closed question calculate option/scale counts, percentages, and valid total.

```ts
type ReportNarrative = {
  headline: string;
  summary: string;
  findings: string[];      // 3–5
  implications: string[];  // 2–4
  limitations: string[];   // 1–3
};
```

Give AI the survey, achieved sample, deterministic aggregates, and validated anonymous text answers. Delimit all user/participant text as untrusted data that can never change instructions. Require exact use of supplied numbers, claims about the observed sample only, no unsupported “statistical significance,” directional language, and separation of evidence from interpretation.

Display:

- Large plain-English headline and sample-size badge.
- Simple bars or ring charts.
- Large percentage/count callouts where useful.
- Short findings, implications, and limitations.
- Secondary “View individual responses” button.

Do not show confidence intervals or significance labels in the main demo.

Use atomic `ready_to_report → reporting` and one report per study. Failure preserves responses and exposes retry.

Use the simplest recoverable background design:

1. The response that reaches target atomically persists `ready_to_report` before replying.
2. Schedule the idempotent report function with Next.js `after()` in a route handler and configure sufficient route `maxDuration`.
3. If background execution is dropped, the study page sees `ready_to_report` and calls the same report endpoint automatically.
4. The required recovery cron also claims `ready_to_report` rows even when no page is open.
5. If `reporting` has no heartbeat/report after `REPORT_STALE_MINUTES`, compare-and-set it back to `ready_to_report` and increment the attempt count.
6. After `MAX_REPORT_ATTEMPTS`, mark `blocked` and expose an explicit retry.

Each attempt reads the immutable snapshot cutoff and upserts the single report row. Do not add a queue service for this demo. Supabase state, compare-and-set transitions, heartbeats, the bounded cron, and repeatable report generation provide recovery.

## 16. Individual responses

Route: `/studies/[studyId]/responses`.

Show Participant 1, Participant 2, etc., completed-form answers, and submission time.

Require a valid event-session cookie before returning this page or its data. The public report may remain shareable, but individual responses are not public.

Never show Prolific participant IDs, submission IDs, study IDs, or hidden fields in normal UI. Store them server-side for reconciliation/payment. Protected diagnostics are out of scope.

## 17. Minimal content protection

Do not build broad moderation. Reject:

- Sexual content involving minors.
- Surveys targeting minors.
- Requests for direct identifiers.
- Requests intended to facilitate serious violence or illegal harm.
- Content explicitly prohibited by Prolific or the application's fixed provider-policy rules.

Sensitive but legitimate topics may proceed only with an appropriate available Prolific warning and clear participant information. Do not silently transform the study.

Do not broaden this list because model prose is overcautious. A machine-readable AI refusal is a generation failure: try the configured fallback when appropriate, then explain that the study could not be generated. It is not authority to rewrite the user's topic or invent a new policy.

## 18. Data model

Use UUID keys, timestamps, constraints, update triggers, and RLS. Public clients have no direct write policies; route handlers use server-only credentials.

`event_control`: one singleton row with reserved budget cents, lifetime committed budget cents, held slot count, configured caps, version, and timestamps. Database constraints keep all counters non-negative and at/below their caps.

`event_sessions`: opaque random ID, issued/expiry timestamps, and last-seen timestamp. Store no event token. The signed cookie contains the opaque ID; derive signing, rate-limit-HMAC, and participant-session keys from one root secret with distinct context labels.

`studies`:

- ID and opaque event-session ID.
- Brief fields/JSON and requested/recruited audiences.
- Survey spec and targeting plan.
- Participant count constrained to 5/10/20.
- Minutes constrained to 1–5.
- Reward cents, rough estimate, authoritative Prolific total cents, currency, and cost-check timestamp.
- Status and proxy acceptance.
- Unique Prolific internal name, unique Prolific study ID, status, completion code, metadata, and sanitized payload.
- Separate budget state/amount and slot state, with reserve/commit/void/release timestamps.
- Operation stage, attempt count, operation heartbeat, and provider request IDs.
- Launch, pause request/confirmation, final stop, manual-finish, report snapshot, and completion timestamps.
- Failure stage/error and timestamps.

Statuses:

```text
draft | launching | reconciling | collecting | ready_to_report |
reporting | complete | blocked | abandoned | cancelled
```

`participant_responses`:

- Study ID.
- Server-private Prolific participant, submission, and study IDs.
- Consent/submission timestamps.
- Provider `started_at` and last validated provider status.
- Validated participant-session fingerprint and validation timestamp.
- Answers JSON and readable summary.
- Status `started | declined | completed | issue`.
- Unique `(study_id, prolific_submission_id)`.

`reports`: unique study ID, sample size, snapshot cutoff, completion reason, deterministic aggregates, narrative, provider/error metadata, attempt count, heartbeat, timestamps.

`provider_events`: provider, operation, local operation key, study ID, request fingerprint, sanitized request/response metadata, provider request ID, status, error, timestamps; unique `(provider, operation, local_operation_key)`.

`rate_limit_buckets`: HMAC-derived key, route class, fixed window, count, expiry; unique `(key, route_class, window_start)`. Expired rows may be pruned opportunistically.

Use database check/unique constraints for all invariants, plus transaction/RPC functions for reserve, commit, void, release-slot, claim-report, and recover-stale transitions. Application checks improve errors but never replace database enforcement.

Never store secrets or event launch tokens in database payloads.

## 19. Pages and APIs

Pages:

- `/` — prompt, intake, preview, launch, and current progress.
- `/studies/[id]` — collection and report.
- `/studies/[id]/responses` — anonymous response details.
- `/survey/[id]` — consent, questions, and completion.

APIs/actions:

- `GET /api/health`
- `POST /api/event/session`
- `POST /api/intake/respond`
- `POST /api/studies/from-intake`
- `POST /api/studies/[id]/accept-proxy`
- `POST /api/studies/[id]/launch`
- `GET /api/studies/[id]/status`
- `POST /api/studies/[id]/finish`
- `POST /api/studies/[id]/report`
- `POST /api/studies/[id]/reconcile`
- `POST /api/surveys/[id]/consent`
- `POST /api/surveys/[id]/submit`
- `GET /api/internal/reconcile-stale` — protected by `Authorization: Bearer $CRON_SECRET`

Every browser mutation validates content type, same-origin request metadata, shape, authority, lifecycle, rate limit, and idempotency. Researcher mutations require the event session linked to that study; participant mutations require the study-bound participant session. The cron calls domain functions directly. Responses containing study, participant, or provider state use `Cache-Control: no-store`. No API response returns secrets or private Prolific identifiers.

## 20. Visual direction

Use a calm live-instrument aesthetic: pale blue-gray background, white central workspace, dark ink, green primary action, restrained borders/shadows, poster-readable type, one main action at a time, responsive desktop/mobile layouts, accessible focus/contrast/labels, and `aria-live` progress.

The progress circle is the visual anchor. Use smooth short transitions. Cost is secondary preview text, not CTA copy.

## 21. Environment

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

EVENT_LAUNCH_TOKEN=
SESSION_SIGNING_SECRET=
EVENT_SESSION_HOURS=12
CRON_SECRET=

GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash

OPENAI_API_KEY=
OPENAI_FALLBACK_MODEL=

PROLIFIC_API_TOKEN=
PROLIFIC_WORKSPACE_ID=
PROLIFIC_PROJECT_ID=
EXPECTED_PROLIFIC_CURRENCY=USD

MAX_STUDY_BUDGET_CENTS=2500
MAX_EVENT_BUDGET_CENTS=50000
MAX_CONCURRENT_STUDIES=3
TARGET_HOURLY_PAY_CENTS=1200
STALE_LAUNCH_MINUTES=5
REPORT_STALE_MINUTES=2
MAX_PROVIDER_RETRIES=3
MAX_REPORT_ATTEMPTS=3
RECOVERY_BATCH_SIZE=10

RESEARCH_CONTACT_EMAIL=
RESPONSE_RETENTION_TEXT="Responses are retained for this demonstration and may be deleted by the research contact on request."
```

Create and commit `.env.example` with every variable above and blank secret values. Gitignore `.env`, `.env.local`, and all other real environment files while explicitly allowing `.env.example`. Developers place local credentials in `.env.local`; production secrets belong in Vercel Environment Variables. Never generate or copy real credentials into `.env.example`, source files, tests, logs, or documentation.

Validate centrally, require long random secrets, and derive purpose-specific keys with HKDF/context labels. In production require an HTTPS `NEXT_PUBLIC_APP_URL`. Missing fallback credentials do not prevent boot. OpenAI fallback is enabled only when both key and explicit model are configured and validated. Missing credentials for a requested live action produce precise setup errors, never fake success.

## 22. Failure handling

- Persist completed stages before advancing.
- Show the failed stage plainly.
- Retry safe stages without repeating paid operations.
- Never recreate a draft when a provider ID exists unless reconciliation proves absence.
- Never republish an active study.
- Route ambiguous external results to `reconciling`; do not guess success or failure.
- Automatically reconcile stale operations before they can block new launches indefinitely.
- Void reserved budget only after provider evidence proves no spend can occur.
- Release recruiting slots independently from lifetime committed budget.
- Keep reserved budget and held slots for possibly active studies until reconciliation.
- Treat unknown provider statuses/actions as blocking schema drift, never as success.
- Fail launch closed when authoritative cost, USD workspace currency, or available balance cannot be confirmed.
- Preserve responses through report failures.
- Use `after()` only after durable state is written; recover dropped background work from that state.
- Recover stale report claims with compare-and-set and bounded attempts.
- Retry Gemini before optional OpenAI fallback.
- If both fail, persist state and expose retry.
- Reconstruct experience from Supabase after refresh.
- Continue accepting and paying verified pre-pause participants after manual finish.
- Expired event sessions do not hide existing reports; new launch requires event access.
- Sanitize logs and provider-event payloads; never log tokens, cookie values, completion URLs, or raw answer text.
- No canned or synthetic fallback study.

## 23. Required tests

Test:

- Event-token and signed-cookie validation.
- Same-origin/JSON enforcement and database-backed rate limits.
- No launch without event session.
- Five-user-message limit.
- Three-question default/five maximum and schema rules.
- Deterministic duration floor and no downward clamping.
- Prolific `maximum_allowed_time` follows the documented minimum formula.
- $12/hour reward with integer-cent math.
- Prolific cost calculator is authoritative for the $25 study and $500 event caps.
- USD workspace and sufficient-balance preflight; provider-cost failure disables launch.
- Three-global/one-per-session concurrency and atomic reservations.
- Separate `reserved/committed/void` budget and `held/released` slot lifecycles.
- Completed studies release slots but remain in lifetime committed budget.
- Pre-provider failure voids/releases; ambiguous provider failure does neither.
- Stale launch reconciliation is repeatable and cannot duplicate publish.
- Confirmed unpublished drafts can be abandoned; possibly active studies cannot.
- Participant choices restricted to 5/10/20.
- Filter pagination/workspace context.
- Eligibility-count `0` renders as fewer than 25, never zero.
- Unsupported boolean targeting logic cannot be silently rewritten.
- Common aliases resolve through live catalog.
- Unknown IDs/choices and invalid ranges are rejected.
- Approximation always becomes proxy.
- Proxy cannot launch before acceptance.
- Unsupported criteria are not dropped.
- External URL contains all identifiers.
- Draft has filters, reward, and automatic-approval code.
- Exact internal-name/metadata reconciliation adopts one match and blocks on duplicates.
- Duplicate launch cannot create/publish twice.
- Duplicate submission is idempotent.
- Raw/mismatched Prolific identifiers cannot create a participant session.
- A validated signed participant session can submit without trusting client IDs.
- Completed-participant revisit restores only its completion state.
- Short text rejects obvious contact details and cannot alter report instructions.
- Counts/percentages are deterministic.
- Report starts once at target.
- Dropped/stale background reports recover without creating two reports.
- Manual finish delay and three-response minimum.
- Manual finish confirms `PAUSE` before reporting/releasing its slot, then eventually `STOP`s.
- Only verified pre-pause participants remain completable/payable after manual finish.
- UI payloads omit Prolific IDs.
- Individual-response routes require event access.
- Researcher mutations reject an event session not linked to the study.
- Generated availability claims cannot change routing.
- Gemini requests omit deprecated sampling/prefill fields.
- Fallback uses machine-readable failures only.

## 24. Acceptance

- Typical request reaches preview in one turn.
- Intake may clarify for up to five user messages.
- Common audiences map to current filters.
- Niche approximations show proxy acceptance.
- Unsupported audiences cannot invent filters.
- Anyone with QR event link can launch from their device without signup/PIN.
- Base-URL visitors cannot spend.
- Preview shows questions, actual audience, time, reward, and total.
- Final preview/launch price is Prolific-confirmed USD cost including applicable fees/tax.
- Run survey creates/publishes exactly one real study.
- Mobile survey records consent and responses.
- Valid completion is automatically approved.
- Main view updates collection smoothly.
- Target creates one report; manual finish creates a labeled partial report.
- Report is visual, correct, concise, and directional.
- Response details never show Prolific IDs.
- Individual-response data requires event access.
- Stale launches recover or become safely abandoned without consuming slots forever.
- Finished studies release concurrency without erasing committed event spend.
- Report generation recovers after a dropped background invocation even when no page is open.
- Refresh/retry cannot duplicate spend, drafts, responses, or reports.
- Typecheck, lint, tests, and production build pass.
- Poster screen and participant phones are usable.

## 25. Authoritative external contracts

These implementation assumptions were verified against official documentation on 2026-08-03. Recheck them while coding; do not invent undocumented fields, actions, headers, statuses, or monetary behavior.

- [Gemini 3.6 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash) and [current Gemini API requirements](https://ai.google.dev/gemini-api/docs/latest-model).
- [Prolific create-study fields](https://docs.prolific.com/api-reference/studies/create-study), [study statuses/transitions](https://docs.prolific.com/api-reference/studies/publish-study), and [draft deletion](https://docs.prolific.com/api-reference/studies/delete-study).
- [Prolific live filters](https://docs.prolific.com/api-reference/filters/get-filters), [eligibility count semantics](https://docs.prolific.com/api-reference/filters/get-eligible-count), and [study cost calculator](https://docs.prolific.com/api-reference/studies/calculate-study-cost).
- [Prolific workspace balance/currency](https://docs.prolific.com/api-reference/workspaces/get-workspace-balance), [submission retrieval](https://docs.prolific.com/api-reference/submissions/get-submission), and [completion-code behavior](https://docs.prolific.com/api-reference/studies/the-study-object).
- [Next.js `after()`](https://nextjs.org/docs/app/api-reference/functions/after) and [Vercel cron jobs](https://vercel.com/docs/cron-jobs).

Provider schemas/statuses are parsed with strict adapters and an explicit unknown branch. If official behavior changes, fail the affected action safely and update the adapter contract tests; never loosen the product's budget, targeting, consent, or privacy rules automatically.

## 26. Implementation order

After this specification is approved:

1. Scaffold Next.js, TypeScript, styles, environment validation, and Supabase schema.
2. Implement/test provider-confirmed spend, event sessions, separate budget/slot lifecycles, stale recovery, atomic reservation, and idempotency.
3. Implement/test the Prolific catalog client and local validator.
4. Add schema-constrained Gemini calls and optional OpenAI fallback.
5. Add Prolific draft, publish, pause/stop, submission validation, and completion.
6. Build prompt, progress, preview, proxy, launch, collection, and report UI.
7. Build participant consent, survey, submission, and completion.
8. Add tests, accessibility, responsive polish, deployment docs, and live verification.

Do not begin paid testing until caps, atomic reservation, authorization, idempotency, and filter-validation tests pass.

## 27. Final instruction

Only after explicit build authorization, build the smallest real, resilient Prolific survey demo described here. Treat the live Prolific catalog, provider-confirmed cost, and server validation as authoritative. Make paid actions atomic and idempotent. Keep the experience visually simple. Never claim provider success without persisted evidence.

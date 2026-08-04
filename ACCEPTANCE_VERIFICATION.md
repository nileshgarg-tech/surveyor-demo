# Acceptance verification

Audit date: 2026-08-03

This file distinguishes implementation evidence from the live checks that are intentionally gated by owner approval and real service configuration. “Verified” means directly exercised by tests, a clean database run, a production build, or local rendering. “Live gate” means the implementation contract is verified but the real deployed/provider outcome has not been claimed.

## Verification runs

- `npm run verify`: passed: strict TypeScript, ESLint, 128/128 Vitest tests, optimized Next.js production build.
- PostgreSQL 17 clean run: all three migrations applied with `ON_ERROR_STOP=1`.
- SQL lifecycle assertions: passed: bounded publish recovery, deletion-only abandonment, PAUSE/STOP evidence-gated retry, slot-release race exclusion, and event-counter audit.
- Runtime-control assertions: passed: stricter environment settings synchronized atomically; values beyond $25/$500/3 studies were rejected.
- Local production smoke: `/` returned 200; participant routes returned `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Headless Chrome render: 1440×900 poster viewport and 390×844 phone viewport rendered without horizontal overflow or clipped primary controls. Service-backed states still require configured Supabase/provider environments.

## Section 24 acceptance criteria

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | Typical request reaches preview in one turn | Live gate | Intake prompt requires immediate readiness when goal/context/adult audience are useful; structured result and one-turn UI path are implemented. Actual Gemini behavior awaits live configuration. |
| A2 | Intake may clarify for up to five user messages | Verified | `intakeStateSchema`, database trigger/check, route CAS, and `runtime-control.test.ts` prove assistant turns do not count and a sixth user turn fails. |
| A3 | Common audiences map to current filters | Live gate | Alias shortlisting, detailed workspace catalog pagination, exact live-ID validation, and adapter tests pass. A current real workspace catalog check awaits live configuration. |
| A4 | Niche approximations show proxy acceptance | Verified implementation | Targeting tests force approximation to `proxy`; preview renders requested/recruited groups, limitations, and persisted acceptance. Live Gemini example awaits configuration. |
| A5 | Unsupported audiences cannot invent filters | Verified | Unknown filters/choices/types/ranges fail locally; unsupported boolean logic and criteria remain explicit and cannot reserve budget. |
| A6 | QR event link launches without signup/PIN | Verified implementation / deployment gate | Timing-safe fragment exchange, signed HttpOnly cookie, fragment removal, and launch authority are tested. A deployed QR scan awaits approval. |
| A7 | Base-URL visitors cannot spend | Verified | Launch route requires a valid event session linked to the study; database reservation independently rejects missing/mismatched/expired sessions. |
| A8 | Preview shows questions, actual audience, time, reward, and total | Verified | Preview component renders every field and provider-confirmed option costs; responsive render passed. |
| A9 | Final price is Prolific-confirmed USD cost including fees/tax | Live gate | Cost-calculator response is authoritative in preview and rechecked inside reservation; integer/USD/balance/cap tests pass. Real returned cost awaits Prolific configuration. |
| A10 | Run survey creates/publishes exactly one real study | Paid live gate | Unique provider operations, exact identity reconciliation, two-publish ceiling, and mutation adapter tests pass. No real paid study was launched without approval. |
| A11 | Mobile survey records consent and responses | Verified implementation / paid live gate | Phone layout rendered; signed participant boundary, consent and idempotent submission RPCs are tested. Real Prolific mobile submission awaits approval. |
| A12 | Valid completion is automatically approved | Verified contract / paid live gate | Draft contains one `AUTOMATICALLY_APPROVE` completion code; successful submit auto-redirects with visible link/code fallback. Provider confirmation awaits live launch. |
| A13 | Main view updates collection smoothly | Verified implementation / live gate | Persisted status is polled every four seconds with `aria-live` progress. Real response arrival awaits live launch. |
| A14 | Target creates one report; manual finish creates labeled partial report | Verified implementation / live gate | Atomic snapshot/unique report/PAUSE-before-freeze paths and recovery are tested; UI labels partial samples. End-to-end provider run awaits approval. |
| A15 | Report is visual, correct, concise, and directional | Verified calculations / live gate | Counts and percentages are deterministic; narrative schema/prompt constrain observed-sample language; charts and limitations are implemented. Human review of a real generated report awaits live data. |
| A16 | Response details never show Prolific IDs | Verified | Safe projection selects only answers/timestamps; API and static privacy tests prove IDs/fingerprints are omitted. |
| A17 | Individual-response data requires event access | Verified | Page verifies signed, unexpired event session and study ownership before loading rows. |
| A18 | Stale launches recover or become safely abandoned without consuming slots forever | Verified | Clean PostgreSQL lifecycle assertions prove exact reconciliation, bounded publish, confirmed deletion, atomic void/release, and ambiguous-state retention. |
| A19 | Finished studies release concurrency without erasing committed spend | Verified | Evidence-gated slot RPC and counter audit prove slot release is independent of lifetime committed budget. |
| A20 | Dropped reports recover without an open page | Verified | The protected five-minute GitHub Actions workflow invokes the bounded internal recovery endpoint, which directly recovers stale/ready reports with locked claims, bounded attempts, heartbeats, and per-row isolation. |
| A21 | Refresh/retry cannot duplicate spend, drafts, responses, or reports | Verified | Unique keys, row locks, compare-and-set transitions, request fingerprints, signed restoration, and idempotency tests cover all four resources. |
| A22 | Typecheck, lint, tests, and production build pass | Verified | `npm run verify` passed with 125 tests across nine files. |
| A23 | Poster screen and participant phones are usable | Partially verified / live gate | Desktop and phone prompt renders passed; responsive/focus/reduced-motion rules exist. Full participant/report device rehearsal awaits configured deployment and live data. |

## Required-test coverage

The Section 23 list is covered across:

- `security-acceptance.test.ts`: event/session signatures, purpose-separated keys, timing-safe comparison, cookie flags, same-origin JSON, size bounds, HMAC rate-limit keys, no-store.
- `survey-money-acceptance.test.ts`: 5/10/20 choices, question schema, duration floor, contact rejection, integer reward/time, provider money, currency/balance/study/event caps.
- `targeting-report-acceptance.test.ts`: catalog aliases and validation, exact/proxy/unsupported routing, boolean logic, censored-zero wording, deterministic report aggregates.
- `prolific-provider.test.ts`: exact draft payload/URL/approval code, safe mutation behavior, catalog/reconciliation pagination, authoritative preflight, status blocking, participant/submission validation, redaction.
- `gemini-provider.test.ts`: current Interactions request, exact model/readiness cache, no deprecated fields or prefill, structured validation, bounded transient retry, machine-readable fallback only.
- `participant-flow.test.ts`: raw identifier rejection, study matching, signed participant session, completed revisit, idempotent submit, contact rejection, safe API output.
- `static-safety-invariants.test.ts`: forced RLS, atomic reservation/concurrency, separate money/slot lifecycles, report/PAUSE invariants, route authority and public projections.
- `recovery-hardening.test.ts`: bounded publish/delete recovery, contextual 404, PAUSE/STOP retry proof, slot race, recorded mutation outcomes, fixed content rules.
- `runtime-control.test.ts`: unweakenable deployment ceilings, runtime-to-database control synchronization, five-minute scheduled recovery, five-turn intake, launch authority, durable target reporting, manual-finish delay.

## Remaining gated evidence

No deployment or real Prolific mutation has occurred. Completing A1/A3/A6/A9–A15/A23 at real-service scope requires the owner’s already-requested approval plus configured Supabase, Gemini, Prolific, Vercel, event-session, GitHub Actions scheduler, and research-contact values. Runtime secrets belong in Vercel; `SURVEYOR_APP_URL` and the matching `CRON_SECRET` belong in GitHub Actions repository secrets. Never paste secrets into source or this document.

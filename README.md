# Surveyor demo

Surveyor is a scaled-down research-operations prototype that turns a plain-English study request into a short, paid Prolific survey and a concise visual report. It is designed as a bounded poster-demo experience: one event organizer can describe a research goal, review an AI-assisted survey proposal, launch a controlled study, and inspect directional results without exposing participant identifiers.

The project demonstrates how an AI assistant can support the operational parts of survey research while keeping money, eligibility, publication, response storage, and reporting under explicit deterministic controls.

## What it demonstrates

- A conversational intake flow that turns a research goal into a structured survey brief.
- A three-to-five-question survey builder with validation for wording, response options, duration, reward, and research-contact requirements.
- Catalog-grounded Prolific targeting: supported audiences use exact provider filters; approximations remain visible and require explicit acceptance.
- A review screen that shows the actual recruited audience, participant-facing questions, estimated completion time, reward, and provider-confirmed total cost before launch.
- Event-link access that uses a signed, short-lived browser session instead of accounts, sign-up, or a PIN.
- A privacy-preserving participant flow for consent and response collection. Organizer response views deliberately omit Prolific participant IDs and fingerprints.
- A deterministic results pipeline that calculates counts and percentages before using an LLM only for a tightly constrained, directional narrative.

## Research flow

```text
Research goal
  → AI-assisted intake
  → survey + targeting preview
  → explicit organizer review
  → controlled Prolific launch
  → mobile participant responses
  → deterministic visual report
```

Supabase is the source of truth for the lifecycle. The browser communicates through Next.js route handlers; it never receives service credentials or direct database-write authority.

## Design and safety controls

Surveyor treats a paid study as a stateful workflow rather than a simple API request.

- Budget is reserved using the provider-confirmed USD cost, then either committed or safely voided.
- Study and event spend caps, a maximum of three concurrent studies, and a one-study-per-event-session limit are enforced in the database.
- Provider operations use idempotency keys, exact reconciliation, bounded retry rules, and recovery jobs for stale launches.
- An unpublished draft may receive at most two total publish attempts. Automatic abandonment requires confirmed draft deletion.
- Publishing, pausing, stopping, approval handling, slot release, and report creation are evidence-gated database transitions.
- All application tables use forced row-level security. Participant-facing routes use `no-store` caching and redact Prolific identifiers.
- Unsupported targeting cannot be silently invented; it is shown as unsupported or as a clearly labeled proxy.

## Technology

- Next.js 16, React 19, TypeScript, and Zod
- Supabase/PostgreSQL with SQL migrations, RPCs, locks, and forced RLS
- Gemini for structured intake and narrative reporting, with optional explicit OpenAI fallback
- Prolific API adapter for targeting, pricing, draft creation, publishing, status checks, and participant completion handling
- Vitest and ESLint for automated verification

## Repository guide

| Location | Purpose |
| --- | --- |
| `src/app` | Application pages and server routes |
| `src/components` | Organizer and participant interfaces |
| `src/lib/domain` | Schemas, targeting logic, money rules, and report calculations |
| `src/lib/services` | Survey lifecycle, participant, recovery, and reporting orchestration |
| `src/lib/providers` | Gemini, OpenAI fallback, and Prolific adapters |
| `src/lib/security` | Event sessions, cryptography, rate limiting, and request protection |
| `supabase/migrations` | Database schema, RLS, atomic lifecycle RPCs, and runtime controls |
| `tests` | Acceptance-focused unit and invariant coverage |

## Verification

Run the full local verification gate with:

```bash
npm run verify
```

This runs strict TypeScript checking, ESLint, 125 Vitest tests, and an optimized production build. The test suite covers survey structure, provider payload validation, targeting behavior, budget/concurrency invariants, event-session security, participant privacy, idempotency, stale-launch recovery, and report generation.

The repository also includes [ACCEPTANCE_VERIFICATION.md](ACCEPTANCE_VERIFICATION.md), which distinguishes locally proven behavior from criteria that require configured third-party services and a real paid Prolific run.

## Demo boundaries

This repository contains no credentials, deployed environment, or live Prolific study. The production-facing integrations are implemented and tested with controlled provider responses, but final live validation requires a configured Supabase project, authorized provider credentials, an HTTPS deployment, and owner approval before any paid launch.

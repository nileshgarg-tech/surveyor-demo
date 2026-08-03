# Surveyor demo

Surveyor turns a natural-language research request into a short, catalog-grounded Prolific survey, recruits real paid adults, and produces a visual directional report from deterministic counts.

This repository implements the bounded poster-demo flow in `SURVEYOR_CODEX_BUILD_SPEC.md`. It has no accounts or simulated participants. Supabase is the source of truth; all browser writes go through Next.js route handlers.

## Local setup

Requirements:

- Node.js 24 or newer
- A Supabase project or compatible local Supabase stack
- Gemini and Prolific credentials for live design/provider checks
- Optional OpenAI credentials plus an explicit model for transient Gemini fallback

Install and configure:

```bash
npm ci
cp .env.example .env.local
```

Fill `.env.local`; never put real credentials in `.env.example`. Use independent random values of at least 32 characters for `EVENT_LAUNCH_TOKEN`, `SESSION_SIGNING_SECRET`, and `CRON_SECRET`.

Apply all migrations in order:

```text
supabase/migrations/202608030001_initial.sql
supabase/migrations/202608030002_recovery_hardening.sql
supabase/migrations/202608030003_runtime_control.sql
```

With a linked Supabase CLI project, `supabase db push` applies the pending migrations. Then start the app:

```bash
npm run dev
```

Open `http://localhost:3000`. Preview-only use needs no event link. Paid launch authority comes from:

```text
http://localhost:3000/#event=<EVENT_LAUNCH_TOKEN>
```

The browser exchanges the fragment once for a signed HttpOnly event-session cookie and removes it from history.

## Verification

Run the complete local gate:

```bash
npm run verify
```

This runs strict TypeScript, ESLint, Vitest, and a production Next.js build. Provider adapter tests use mocked HTTP responses and do not create studies or spend money.

The schema has also been designed for a clean PostgreSQL 17 migration run. Validated environment controls are synchronized idempotently into the locked database control row. Important state transitions are database RPCs: exact-cost reservation, budget commit/void, slot release, idempotent submission, PAUSE/STOP confirmation, report claims, and stale recovery. All application tables have forced RLS and no browser-role policies.

## Operating model

- `vercel.json` invokes `/api/internal/reconcile-stale` every two minutes.
- The endpoint requires `Authorization: Bearer $CRON_SECRET`, processes bounded batches, and directly runs stale provider recovery, report recovery, recruiting-status checks, and final STOP checks.
- Ambiguous paid mutations retain reserved budget and held slots until exact Prolific evidence resolves them.
- An unpublished draft gets at most two total publish attempts. If it remains unpublished, automatic abandonment occurs only after confirmed deletion.
- Report calculations are deterministic; Gemini or the configured OpenAI fallback writes only the narrative.
- Individual responses require the still-valid event session that owns the study and never expose Prolific identifiers.

## Deployment and real paid launch

Production uses Vercel Environment Variables and requires an HTTPS `NEXT_PUBLIC_APP_URL`. Apply migrations before deploying, configure every required live credential, and retain the cron definition.

Deployment and the first real paid Prolific launch are explicit approval gates. Do not perform either from this repository until the project owner has reviewed the environment, caps, project/workspace IDs, and granted approval.

After approval, rehearse in this order:

1. Check `/api/health` for database, Gemini, Prolific project/workspace, USD currency, and balance readiness.
2. Open the event fragment on a clean browser and confirm it changes to “Event access ready.”
3. Design a small five-participant survey and verify the provider-confirmed total remains under the configured study and event caps.
4. Inspect the Prolific draft payload and validated filters before the first publication.
5. Launch once, complete the mobile participant flow, and confirm automatic approval, reporting, slot release, and the event counter audit.

No deployment or live paid Prolific mutation is part of `npm run verify`.

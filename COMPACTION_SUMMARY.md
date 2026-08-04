# Surveyor Agent: Session Compaction & Handoff Briefing

**Repository**: `nileshgarg-tech/surveyor-demo` (`main`)  
**Latest Verified Commit**: `86c7b0e`  
**Test Suite**: 129 / 129 Vitest tests passing (`npm run verify` clean)

---

## 1. System Architecture Overview

Surveyor Agent is an autonomous survey design and participant recruitment engine integrated with **Google Gemini 3.6 Flash** (with live Web Search Grounding), **OpenAI GPT Fallback**, **Prolific API**, and **Supabase**.

### Key Flow
1. **Natural Language Intake** (`/`): User describes research topic & target audience.
2. **Gemini Live Search Grounding**: Verifies real-world entities (e.g., candidates in political races, active market alternatives) and generates a 2 to 6 question survey.
3. **JSON Schema Normalizer** (`sanitizeIntakeJson` in `src/lib/providers/gemini.ts`): Converts LLM output drift (`id` $\rightarrow$ `ref`, `text` $\rightarrow$ `title`, `options` $\rightarrow$ `choices`, `single_choice`/`matrix` $\rightarrow$ `multiple_choice`) before Zod validation.
4. **Draft Preview & Approval**:
   - If `launchConfirmedAt === null`: Renders the full `PreviewPanel` (question breakdown, audience match check, sample size options $6.67 for 5, $13.33 for 10, $26.67 for 20, and green **Run survey** button).
5. **Live Prolific Launch**:
   - Clicking **Run survey** calls `POST /api/studies/[id]/launch`, reserves budget, creates Prolific study, and transitions to live collection (`/studies/[id]`).

---

## 2. Recent Major Fixes & Key Implementation Details

### A. Gemini Search Grounding Schema Normalization
- **File**: [gemini.ts](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/lib/providers/gemini.ts)
- **Feature**: `sanitizeIntakeJson()` normalizes schema variations when live Google Search tool is active. Unrolls `matrix` questions into clean `multiple_choice` questions for participants.

### B. State-Based UI Separation (Draft Preview vs Collection)
- **Files**: [study-dashboard.tsx](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/components/study-dashboard.tsx), [surveyor-app.tsx](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/components/surveyor-app.tsx)
- **Feature**:
  - `launchConfirmedAt === null` $\rightarrow$ Renders `PreviewPanel` (full setup, sample size selection, no `0 of 10` progress ring).
  - `launchConfirmedAt !== null` $\rightarrow$ Renders `CollectionWorkspace` (`0 of 10` progress ring, live responses, or final AI report).

### C. Direct Study Update API & Session Auto-Binding
- **Files**: [auth.ts](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/lib/security/auth.ts), [route.ts](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/app/api/studies/%5Bid%5D/route.ts)
- **Feature**:
  - `requireResearcherStudy()` auto-binds unlaunched draft studies to active session IDs, eliminating *"This event session does not control that study"* errors.
  - Added `POST /api/studies/[id]` handler to update participant counts (5, 10, 20) directly without requiring an active intake cookie.

### D. Hardened Budget Caps ($30.00 Study Ceiling)
- **Files**: [env.ts](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/lib/env.ts), [runtime_control.sql](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/supabase/migrations/202608030003_runtime_control.sql), [data.ts](file:///home/nilesh-garg/workspace/domains/ai/Surveyor%20Agent/surveyor-demo/src/lib/data.ts)
- **Feature**:
  - `MAX_STUDY_BUDGET_CENTS` default fallback set to `3000` ($30.00) with a max ceiling of `3500` ($35.00).
  - `parseCostOptions()` dynamically evaluates `enabled` status against active `MAX_STUDY_BUDGET_CENTS`, retroactively enabling **20 participants ($26.67)** on existing and new studies.

---

## 3. How Context Persistence Works in Antigravity

In Antigravity, context compaction and session handoff are managed automatically through artifacts and KIs:

1. **Artifact Directory Persistence**:
   - All session state, task tracking (`task.md`), and walkthroughs (`walkthrough.md`) are saved in `<appDataDir>/brain/<conversation-id>/`.
2. **Handoff to Opus or Fresh Sessions**:
   - Any new model session reading this workspace will automatically inspect `COMPACTION_SUMMARY.md` or `walkthrough.md` to pick up exact codebase context without losing any history.

---

## 4. Verification Commands

To verify full project health anytime:
```bash
npm run verify
```
Runs:
1. `tsc --noEmit` (TypeScript typechecking)
2. `eslint .` (Linting)
3. `vitest run` (129 unit & invariant tests)
4. `next build` (Next.js Turbopack production build)

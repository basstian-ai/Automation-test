
Vision

An autonomous, self-improving development loop for a small but growing PIM (Product Information Management) system built with Next.js and deployed on Vercel.
The vision is that the PIM is never “done” — instead, an AI agent continuously:
	1.	Monitors the health of the application.
	2.	Fixes any build/runtime errors automatically.
	3.	Ships small, incremental improvements to features and tests.

Over time, the AI will evolve the PIM into a more complete, robust, and feature-rich product without manual coding in between runs.

⸻

Goals

1. Continuous Health
	•	Detect deployment or local build failures.
	•	Apply targeted fixes automatically to keep the app deployable at all times.

2. Incremental Feature Growth
	•	When the build is green, the AI switches to “FEATURE” mode:
	•	Adds small, safe improvements to the PIM.
	•	Introduces tests (unit/integration) to improve coverage.
	•	Enhances UI/UX or admin tooling for product management.

3. Autonomous Feedback Loop
	•	Use Vercel build/runtime logs as feedback for deciding what to do next.
	•	No human intervention needed between cycles — the loop runs every 15 minutes via GitHub Actions.

4. Minimal, Shippable Changes
	•	Each change should be small enough to be safely deployed without breaking the app.
	•	Prefer diffs over rewriting large files (unless context is stale).

⸻

High-Level Workflow & Intent
	1.	Sync with the target repo (simple-pim-1754492683911) at the latest main commit.
	2.	Fetch Vercel deployment state and build/runtime logs:
	•	If deployment is ERROR or build fails locally → go into FIX mode.
	•	If deployment is READY → go into FEATURE mode.
	3.	Prepare AI context:
	•	Mode (FIX or FEATURE).
	•	Logs (build/runtime trimmed).
	•	Repo file list & key file snippets.
	4.	Ask OpenAI model (now gpt-5) for a patch:
	•	Prefer unified_diff.
	•	If diff fails → retry with files[] containing full file content.
	5.	Apply changes:
	•	Commit & push if applied successfully.
	•	If build fails after patch, request AI to fix locally until green.
	6.	Repeat on next scheduled run.


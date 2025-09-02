Here’s a clear, end-to-end spec of what the “AI Dev Agent” is meant to do and how it works.

Intention (the “why”)

Build and maintain software autonomously in small, safe increments. The agent keeps the repo deployable at all times:
	1.	Fix what’s broken (red build) and 2) move the product forward (green build), with human-quality commits, tests, docs, and a transparent audit trail. It’s project-agnostic (works on any repo) and aims to be a dependable junior-to-mid engineer that never gets tired.

High-level loop (the “how”)
	1.	Trigger (on schedule or on push)
	2.	Sense: Read the repo + latest deploy/build status/logs
	3.	Decide: Red path = repair; Green path = implement next valuable improvement
	4.	Act: Create minimal diffs, run checks, commit, push, open PR if needed, redeploy
	5.	Reflect: Update changelog/notes, backlog state, and telemetry
	6.	Repeat

Inputs & Outputs

Inputs
	•	Build signals: Deploy status + logs (e.g., Vercel API), parsed into issues[] and trimmedLogs.
	•	Repo snapshot: repoFiles[], repoTree[], export facts, package manifests.
	•	Roadmap: roadmap/vision.md (protected) with tasks tracked in Supabase.
	•	Constraints: allowedOps[], commitStyle, protected paths, diff size limits.
	•	Context: Framework/language hints, package manager, test commands.

Outputs
	•	Unified diff (single patch per run when possible).
	•	Commits/PRs with conventional, traceable messages.
	•	Updated docs/tests when code changes.
	•	Agent notes stored in Supabase.
	•	Roadmap progress: statuses/links back to PRs.

Task progress, decisions, and changelog entries are stored exclusively in Supabase tables.

Two paths in detail

A) Red path — Repair first
	•	Parse build logs → cluster issues → map to files/symbols.
	•	Apply minimal, safe patches following repo style and provided rules[].
	•	Run unit/build checks locally (or via CI dry-run).
	•	If repair succeeds: commit with message linking to log lines and root cause.
	•	If repair fails after N attempts: open an Issue with a concise reproduction + proposed fix plan; back off.

B) Green path — Continuous improvement
	•	Prioritize from Supabase tasks (or synthesize from repo gaps if empty).
	•	Pick a thin vertical slice (tests + code + docs).
	•	Implement in small, deployable steps; keep the app green after each step.
	•	Update backlog item status, link to commit/PR, and record brief rationale in Supabase.

Component breakdown
	•	Orchestrator: Entry script/Action that schedules runs and wires everything.
	•	Collectors:
	•	Repo scanner (files, tree, exports)
	•	CI/deploy fetcher (e.g., Vercel latest deploy + logs)
	•	Test runner / typechecker hooks
	•	Analyzers:
	•	Log parser → issues[] (errors/warnings with locations & likely causes)
	•	Codebase indexer (symbols, dependency graph, tech fingerprint)
	•	Delta risk assessor (how risky is a change?)
	•	Planner (LLM): Decides Fix vs Improve, writes a small plan, and proposes a single unified diff.
	•	Executor: Applies patch, runs checks, commits, pushes, opens PR, triggers deploy.
	•	Memory & Governance: Stores run metadata and changelog entries in Supabase, respects protected files and allowedOps[].

Guardrails & safety
	•	Protected paths (e.g., roadmap/vision.md) are read-only. The agent refuses to modify them.
	•	Allowed ops whitelist: file types and directories it may touch; dependency changes gated behind explicit flag.
	•	Small, reversible steps: diff size limits; rollbacks on post-merge failure.
	•	Style conformity: enforces formatter/linter/tsc/tests before committing.
        •       Automated validation: `npm run check` and `npm test` run before a commit and the commit is aborted on failure.
	•	Traceability: every commit links to the problem (log line/issue id) or corresponding Supabase task.
	•	Fallbacks: if blocked by permissions/credentials (e.g., 400/403 from deploy API), it files an actionable Issue rather than guessing.

Files & conventions the agent uses
	•	agent/config.json – project hints (framework, package manager, test scripts), and guardrails.
	•	Supabase tables – run metadata, decisions, changelog entries, repo summaries, and roadmap items.
	•	Supabase tasks table – backlog the agent pulls from (the agent can propose ~30 items if empty).
	•	.github/workflows/ai-dev-agent.yml – schedule (e.g., every 4h) and permissions.

Note: repo summaries and roadmap items are stored exclusively in Supabase.

Triggers & cadence
	•	Cron (e.g., hourly/4-hourly) and on push to default branch.
	•	Optional manual dispatch with parameters (e.g., “repair only”, “no deps”, “limit diff to N lines”).

Commit & PR etiquette
	•	Conventional commits (e.g., fix(api): handle 413 from upload endpoint)
	•	Body must include: root cause, scope, validation steps, and links to logs/issue/Supabase task.
	•	PR template auto-filled with test evidence and risk notes.

Observability
	•	Summaries posted as PR comments on runs that affect a PR.
	•	Status badge or check that reports: “Analyzed ▸ Planned ▸ Patched ▸ Tested ▸ Deployed”.
	•	Minimal run metrics (duration, diff size, tests run, result) recorded in Supabase.

Failure & recovery strategy
	•	Access failures (e.g., Vercel 400/403): record exact endpoint + payload expectation, open an Issue titled “Unblocked CI access required” with a checklist (token, project id, scope).
	•	Repeated red build: stop patching after N unsuccessful tries; open an Issue with bisect plan or suggest human review.
	•	Risky migrations: if data migration detected, the agent drafts a plan and a guarded script but doesn’t run it without a flag.

Project-agnostic behavior
	•	Auto-detects language/framework (Next.js, Node, TS/JS, Python, etc.) and chooses idiomatic patterns.
	•	If no tests exist, proposes and adds the first test around the touched module to start a testing baseline.
	•	If no tasks exist, seeds the Supabase tasks table with ~30 value-centric items (performance, DX, tests, docs, UX polish) tagged by effort/impact.

Setup requirements (minimal)
	•	Credentials: GitHub token (repo), Deploy provider token (e.g., Vercel) + project id.
	•	Permissions: Push rights (or PR-only mode), access to build logs.
	•	Config: agent/config.json (or zero-config with sensible defaults).

Example run (narrative)
	1.	Cron triggers at 09:00.
	2.	Fetch latest deploy → failed with TypeError: cannot read properties of undefined (headers).
	3.	Parser maps error to bff/utils/fetchData.js and a missing header guard; proposes a 6-line fix + unit test.
	4.	Runs linter/tsc/tests → green. Commits with linked log snippet.
	5.	Redeploy kicks → green.
	6.      Green path: picks “Add API timeout & retry with exponential backoff” from the Supabase tasks backlog.
	7.	Implements small, feature-flagged change + tests + docs; opens PR with validation steps; logs the rationale in Supabase.

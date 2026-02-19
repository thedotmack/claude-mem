# Phase 01: Autonomous Prototype Triage Runner

This phase builds a fully autonomous, working Issue/PR triage prototype that requires no user decisions at runtime. It establishes the core project structure, fetches open issues and open PRs for `thedotmack/claude-mem`, classifies and prioritizes items (including developer-aware weighting for `thedotmack`, `bigph00t`, and `glucksberg`), flags outdated candidates, and produces tangible ranked outputs with draft action plans.

## Tasks

- [x] Reuse-first discovery and scaffold setup:
  - Search existing patterns before writing new code (start with `scripts/bug-report/*`, `scripts/generate-changelog.js`, and `.github/workflows/*` for CLI, API, and report conventions)
  - Create a new triage workspace under `scripts/issue-pr-bot/` with modular files for config, ingestion, scoring, reporting, and CLI entry
  - Keep implementation in TypeScript and compatible with existing `tsx`/Node workflow used by current scripts
  - Notes (2026-02-19): Reused conventions from `scripts/bug-report/*`, `scripts/generate-changelog.js`, and `.github/workflows/*`; added scaffold modules in `scripts/issue-pr-bot/{types,config,ingestion,scoring,reporting,index,cli}.ts`; added smoke coverage in `tests/scripts/issue-pr-bot/scaffold.test.ts`.

- [x] Implement default configuration with zero-interaction runtime behavior:
  - Encode discovery defaults directly in code: scope=`open issues + open PRs`, outdated threshold=`90 days`, output sections=`separate issues and PRs`
  - Set default repository to `thedotmack/claude-mem` and default developer-priority order to `thedotmack`, `bigph00t`, `glucksberg`
  - Add deterministic constants for severity/priority buckets so repeated runs produce stable ordering
  - Notes (2026-02-19): Added explicit config defaults in `scripts/issue-pr-bot/config.ts` for scope (`open-issues-and-prs`), outdated threshold (`90` days), output sections (`issues`, `prs`), and developer priority order (`thedotmack`, `bigph00t`, `glucksberg`); expanded `TriageConfig` shape in `scripts/issue-pr-bot/types.ts`; introduced deterministic severity/priority bucket order + weight constants in `scripts/issue-pr-bot/scoring.ts` and applied them in ranking; updated scaffold coverage in `tests/scripts/issue-pr-bot/scaffold.test.ts`.

- [x] Build GitHub ingestion and normalization pipeline:
  - Fetch open issues and open PRs via GitHub API (reuse existing auth/env conventions where possible)
  - Implement fallback logic when auth is missing/rate-limited (for example, best-effort public API mode with clear warning)
  - Normalize records into a shared internal shape that includes author, timestamps, labels, assignees, changed-files stats (for PRs if available), and links
  - Notes (2026-02-19): Replaced scaffold ingestion with live GitHub API ingestion in `scripts/issue-pr-bot/ingestion.ts` using `GITHUB_TOKEN`/`GH_TOKEN` auth conventions, paginated `issues` fetch, per-PR stats enrichment via `pulls/{number}`, and explicit warnings for missing auth, authenticated rate-limit fallback to public mode, and incomplete PR stat enrichment failures; expanded normalized schema in `scripts/issue-pr-bot/types.ts` to include `links` and `pullRequest` stats; added ingestion-specific fixture tests in `tests/scripts/issue-pr-bot/ingestion.test.ts` and updated scaffold tests in `tests/scripts/issue-pr-bot/scaffold.test.ts`.

- [x] Implement prototype triage engine (classification, prioritization, outdated candidates):
  - Categorize each item by type and intent using labels + title/body heuristics (bug, feature, docs, maintenance, refactor, test, infra)
  - Compute importance score and rank independently for issues and PRs
  - Apply developer-aware weighting rules for the three named developers while still keeping globally critical items at top priority
  - Mark outdated-close candidates using 90+ day inactivity, superseded references, and obvious already-resolved signals
  - Notes (2026-02-19): Replaced placeholder scoring with a deterministic triage engine in `scripts/issue-pr-bot/scoring.ts` that classifies intent via label/title/body signals, resolves severity + priority buckets, applies developer-aware score boosts for `thedotmack`, `bigph00t`, and `glucksberg`, and flags outdated-close candidates when inactivity crosses the configured threshold and superseded/resolved/stale signals are present; expanded ranked item metadata in `scripts/issue-pr-bot/types.ts`; wired config-driven scoring options in `scripts/issue-pr-bot/index.ts`; added focused heuristic coverage in `tests/scripts/issue-pr-bot/scoring.test.ts` and updated deterministic scaffold expectations in `tests/scripts/issue-pr-bot/scaffold.test.ts`.

- [x] Generate first structured triage artifacts with per-item draft plans:
  - Create `docs/triage/issues/` and `docs/triage/prs/` outputs with Markdown front matter (`type`, `title`, `created`, `tags`, `related`)
  - Write one machine-readable snapshot file and one human-readable ranked report per run
  - For each non-outdated remaining item, include a concise draft execution plan (next steps, risks, validation checks)
  - Add wiki-links across artifacts (for example `[[Issue-<number>]]`, `[[PR-<number>]]`, and `[[Triage-Run-<date>]]`)
  - Notes (2026-02-19): Reworked triage reporting in `scripts/issue-pr-bot/reporting.ts` to render wiki-linked ranked sections, deterministic run identifiers, machine-readable snapshot data, and per-item draft execution plans for non-outdated items; added artifact writers that emit front-matter Markdown files under `docs/triage/issues/` and `docs/triage/prs/` plus run-level report/snapshot files; extended `scripts/issue-pr-bot/types.ts` report/snapshot schemas and wired artifact persistence into `scripts/issue-pr-bot/index.ts`; added focused artifact-shape coverage in `tests/scripts/issue-pr-bot/reporting.test.ts` and validated with `bun test tests/scripts/issue-pr-bot`.

- [x] Add a runnable prototype command and terminal summary:
  - Create a CLI entry script that runs the full pipeline end-to-end without prompts
  - Print a compact summary: total open issues/PRs, outdated-close candidates, duplicate/related hints found, and top priorities
  - Add npm script(s) (for example `issue-pr-bot:prototype`) to run from project root
  - Notes (2026-02-19): Updated `scripts/issue-pr-bot/cli.ts` to run end-to-end ingestion/scoring/reporting with artifact writes enabled by default, added compact terminal summary generation in `scripts/issue-pr-bot/summary.ts` (totals, outdated counts, duplicate/related hints, top priorities), added root command `issue-pr-bot:prototype` in `package.json`, and added summary coverage in `tests/scripts/issue-pr-bot/summary.test.ts`.

- [x] Write prototype tests (separate from implementation):
  - Add focused tests for scoring determinism, outdated detection, and issue-vs-PR section separation
  - Include fixture-based ingestion tests so the pipeline can be validated without live network dependency
  - Add report-shape tests that verify front matter presence and expected wiki-link fields
  - Notes (2026-02-19): Added fixture-backed ingestion payloads under `tests/fixtures/issue-pr-bot/ingestion/` and updated `tests/scripts/issue-pr-bot/ingestion.test.ts` to load fixtures instead of inline JSON; added deterministic repeated-run ranking coverage in `tests/scripts/issue-pr-bot/scoring.test.ts`; added explicit issue-vs-PR section separation and front-matter/wiki-link shape assertions in `tests/scripts/issue-pr-bot/reporting.test.ts`; validated with `bun test tests/scripts/issue-pr-bot` (36 passing).

- [ ] Run validation and produce the first visible prototype deliverable:
  - Execute the new test subset and fix failures
  - Run the prototype command successfully to generate real output artifacts in `docs/triage/`
  - Confirm the generated report clearly shows ranked issue and PR sections with draft plans per remaining item

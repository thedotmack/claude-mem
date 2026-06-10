# Opt-In PostHog Telemetry for claude-mem

**Goal:** One mergeable PR adding privacy-respecting, OPT-IN product analytics to claude-mem using the official `posthog-node` SDK, gated by a consent resolver and a whitelist property scrubber. Ships dark: default OFF, nothing leaves the machine without explicit consent.

**Origin:** Research on branch `claude/analytics-platforms-comparison-o58erd` (commit 256b3584f, `claude-mem-analytics-research-transcript.txt`) + the official PostHog skill (`npx skills use posthog/ai-plugin@instrument-product-analytics`).

## Architecture decision (locked — do not re-litigate)

The research transcript proposed a SQLite `telemetry_events` spool table drained by a worker flush job. **We are NOT building that.** The spool solved "short-lived hook processes exit before the SDK's in-memory queue flushes" — but in claude-mem all the events worth tracking (compression, search, startup, errors) occur **inside the long-running worker service**, which is exactly where a `posthog-node` client is designed to live. So:

- `posthog-node` SDK initialized lazily, once, in the worker. SDK handles batching/retry/flush.
- NO new SQLite migration. NO custom `/batch/` wire format. NO custom retry loop.
- Every capture goes through ONE wrapper: consent gate → whitelist scrub → debug-print or `posthog.capture()`. The wrapper never throws and never blocks.
- `cli.command` events from short-lived npx processes are **scope-cut from v1** (future: POST to worker HTTP). Keeps the PR small.

What we keep from the research (the trust-critical layer):
- Opt-in, default OFF. Consent precedence: `DO_NOT_TRACK` (truthy → forced off) > `CLAUDE_MEM_TELEMETRY` env (`0/false/off` → off, `1/true/on` → on) > `telemetry.json` config > default OFF.
- Random install UUID (crypto.randomUUID, first use) + consent stored in `~/.claude-mem/telemetry.json` (data dir via existing helper; survives DB resets). UUID = PostHog `distinctId`.
- Whitelist scrubber. Allowed property keys ONLY: `version`, `os`, `arch`, `runtime`, `runtime_version`, `duration_ms`, `outcome`, `error_category`, `locale`, `is_ci`, plus the event name. Everything else dropped. NEVER: paths, project names, git remotes, prompts, source code, IPs, hardware IDs (even hashed), env values, emails.
- `CLAUDE_MEM_TELEMETRY_DEBUG=1` → print would-be payloads to stderr, send nothing.
- `claude-mem telemetry [status|enable|disable]` CLI command.
- `docs/public/telemetry.mdx` enumerating every field collected and not-collected.
- Unit tests for the consent resolver and the scrubber.

## Allowed APIs (verified)

**posthog-node** (https://posthog.com/docs/libraries/node — re-read before coding):
- `new PostHog(apiKey, { host, flushAt, flushInterval })` — host default `https://us.i.posthog.com`; key/host via `CLAUDE_MEM_TELEMETRY_KEY` / `CLAUDE_MEM_TELEMETRY_HOST` env with a hardcoded **publishable project token** fallback constant (publishable tokens are safe to embed — verified at posthog.com/docs/api: capture endpoints are public POST-only, no rate limits, 20MB body cap).
- `client.capture({ distinctId, event, properties })` — fire-and-forget, queues in memory.
- Set `properties.$process_person_profile = false` on every event (anonymous events — cheaper, privacy-aligned).
- `await client.shutdown()` — flush on worker graceful stop ONLY. Never on the capture path.

**Codebase facts (verified 2026-06-09):**
- Migration runner is at version 34 (`src/services/sqlite/migrations/runner.ts`) — we deliberately do not touch it.
- Tests: `bun test`, files at `tests/**/*.test.ts`, import from `bun:test`; copy style from `tests/json-utils.test.ts`.
- Worker code: `src/services/worker/` (Express `http/`, `SettingsManager.ts`, providers). CLI commands: `src/npx-cli/commands/` (e.g. `doctor.ts`).
- `@clack/prompts` is already a dependency (used by installer flows).
- Event naming: snake_case (per official PostHog skill).

## Phase 1 — Discovery + consent & scrub core (pure logic, no network, no SDK)

1. Grep for existing `posthog`/`telemetry` references (expect only incidental SDK-flag mentions in `ProviderObservationGenerator.ts`, `ClaudeProvider.ts`, `ChromaMcpManager.ts` — read them to confirm they're unrelated, do not modify).
2. Find the existing data-dir helper that resolves `CLAUDE_MEM_DATA_DIR` / `~/.claude-mem` (grep `CLAUDE_MEM_DATA_DIR` in `src/`), and the `readJsonSafe` util (`src/utils/json-utils.ts`). Reuse both.
3. Create `src/services/telemetry/consent.ts`:
   - `resolveTelemetryConsent(env, config): boolean` — pure, precedence as locked above.
   - `loadTelemetryConfig() / saveTelemetryConfig()` — `telemetry.json` in data dir: `{ enabled: boolean, installId: string, decidedAt: string }`.
   - `getOrCreateInstallId(): string`.
4. Create `src/services/telemetry/scrub.ts`: `scrubProperties(props): Record<string, string|number|boolean>` — whitelist filter, primitive-only values, truncate strings >200 chars.
5. Tests: `tests/telemetry/consent.test.ts`, `tests/telemetry/scrub.test.ts` (style of `tests/json-utils.test.ts`). Cover: DO_NOT_TRACK=1 beats enabled config; env off beats config on; default off; unknown keys dropped; nested objects dropped; denylisted-looking keys (path, cwd, prompt) dropped even if someone whitelists by mistake — add an explicit denylist assertion test.

**Verify:** `bun test tests/telemetry/` green. No imports from `posthog-node` anywhere yet.

## Phase 2 — SDK wrapper + worker capture sites

1. `npm install posthog-node` (package manager command, do not hand-edit package.json). Check `esbuild`/build config: if worker bundle has an `external` array pattern (it did for `bullmq`/`pg`), determine whether `posthog-node` bundles cleanly; mirror the existing convention.
2. Create `src/services/telemetry/telemetry.ts`:
   - Lazy singleton `getClient()` — constructs PostHog only on first consented capture.
   - `captureEvent(event: string, props?: Record<string, unknown>): void` — consent gate → base props (version from package.json/version helper, `os`, `arch`, `runtime: 'bun'|'node'`, `runtime_version`, `is_ci`, `locale`) → scrub → if `CLAUDE_MEM_TELEMETRY_DEBUG=1` print JSON to stderr and return → else `client.capture({...})`. Entire body in try/catch that swallows (debug-log only). Synchronous, O(1).
   - `shutdownTelemetry(): Promise<void>` — flush with a 3s race timeout; never rejects.
3. Wire capture sites (find exact locations by reading worker code; keep each insertion to 1-3 lines):
   - `worker_started` — worker service startup completion (`src/services/worker-service.ts` or equivalent startup path).
   - `session_compressed` — where a session compression/summarization completes successfully (with `duration_ms`, `outcome`).
   - `search_performed` — `SearchManager` / search HTTP route entry (NO query text — only `outcome`).
   - `error_occurred` — central worker error handler if one exists (with `error_category` only — a coarse enum string, never `error.message`).
   - `shutdownTelemetry()` in the worker's graceful-stop path (find existing SIGTERM/stop handler).
4. Anti-pattern guards: no `posthog` import outside `src/services/telemetry/`; no `capture(` call site passing raw error messages, paths, or query strings; key only via env/constant.

**Verify:** `npm run build` (or the repo's build script) passes. `bun test` green. Grep checks: `grep -rn "posthog" src/ | grep -v services/telemetry` returns nothing; with consent absent, boot worker with `CLAUDE_MEM_TELEMETRY_DEBUG=1` → zero telemetry stderr lines (gate is before debug print? NO — debug prints only when consented; with no consent, nothing prints. Confirm that ordering in code: consent gate FIRST, debug second).

## Phase 3 — CLI command + docs

1. Read `src/npx-cli/commands/doctor.ts` and the command router that registers it; copy the registration pattern exactly.
2. Create `src/npx-cli/commands/telemetry.ts`:
   - `status` (default): prints enabled/disabled, which layer decided it (DO_NOT_TRACK / env / config / default), install ID, and the docs URL.
   - `enable`: `@clack/prompts` confirm showing the exact field list collected + "no prompts, paths, code, or project names — ever" + docs link; on yes, write config with installId.
   - `disable`: write `enabled: false`. No prompt.
3. Create `docs/public/telemetry.mdx` + add nav entry in `docs/public/docs.json` (check existing `docs.json` structure first): tables of every field collected / explicitly never collected, all four disable methods (DO_NOT_TRACK, env var, config, CLI command), debug mode, where telemetry.json lives, the fact it's opt-in and ships disabled.

**Verify:** run the CLI command locally (`bun src/npx-cli/... telemetry status` per repo's dev pattern) — status reflects env overrides correctly (test with `DO_NOT_TRACK=1`).

## Phase 4 — Verification + PR

1. Full `bun test` and the build script. Fix anything broken by the new dep.
2. Anti-pattern sweep (all must pass):
   - `grep -rn "from 'posthog-node'" src/ | grep -v services/telemetry/telemetry` → empty.
   - `grep -rn "captureEvent(" src/` → every call site's props are literal objects containing only whitelisted keys.
   - No personal API key (`phx_`) anywhere; only publishable (`phc_`) token constant/env.
   - `telemetry.json` never written without explicit user action (enable command) — grep `saveTelemetryConfig` call sites.
3. Branch `feat/opt-in-telemetry` from `main`, commit (conventional: `feat(telemetry): opt-in anonymous usage analytics via PostHog`), push, `gh pr create` with: summary, the architecture-decision paragraph (worker-resident SDK, no spool), the collected/never-collected table, and screenshots/output of `telemetry status`.
4. Hand off to `claude-mem:babysit` for the PR.

**Done means:** PR open, CI green, telemetry provably inert by default (fresh install sends nothing), and the privacy docs page renders.

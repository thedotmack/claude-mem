# Headroom Integration: Token-Optimized Context Delivery to the Primary Agent

**Branch:** `implement-token-headroom`
**Goal:** Integrate the open-source [Headroom](https://github.com/headroomlabs-ai/headroom) project (Headroom Labs, Apache-2.0) into claude-mem so tokens delivered to the primary agent are governed by a budget and compressed where Headroom is strong — while never breaking context delivery when Headroom is absent.

---

## Phase 0: Documentation Discovery (COMPLETE — consolidated findings)

### Allowed APIs — Headroom (`headroom-ai@0.36.5` npm, verified from shipped `dist/*.d.ts`)

```ts
import { compress, simulate } from 'headroom-ai';

// compress(messages: any[], options?: CompressOptions): Promise<CompressResult>
// CompressOptions: { model?, baseUrl?, apiKey?, timeout?, fallback? /* default true */,
//                    retries?, tokenBudget?, hooks?, stack? }
// CompressResult:  { messages, tokensBefore, tokensAfter, tokensSaved,
//                    compressionRatio, transformsApplied, ccrHashes, compressed }

import { HeadroomClient } from 'headroom-ai';
// new HeadroomClient({ baseUrl, apiKey, timeout, fallback, retries, ... })
// client.compress(messages, { model?, tokenBudget? })
// client.retrieve(hash, { query? })          // CCR reversal
// client.health(), client.proxyStats()
```

**Hard constraints (verified):**
- The TS SDK is an **HTTP client only** — "does not touch the filesystem directly" (dist/index.d.ts). Every call POSTs to a running Python proxy (`headroom proxy`, default `http://127.0.0.1:8787`, env `HEADROOM_BASE_URL`). No proxy ⇒ with `fallback: true` the original messages are returned unchanged.
- Python engine install: `uv tool install --python 3.13 "headroom-ai[proxy]"` (Python 3.10+). npm package: zero runtime deps, node >=18, Bun-safe, no native modules.
- Headroom **never compresses**: content under ~300 tokens, arrays under 5 items, source code, system prompts, images. Weak on short prose. **Strong on**: JSON arrays 70–90%, logs 85–95%, search results 80–95%.
- CCR (reversible compression): compressed output carries a marker `[N items compressed to M. Retrieve more: hash=...]`; originals retrievable via `client.retrieve(hash)`; LRU cache TTL default 1800 s — expired hashes fail retrieval.
- Token counting is Headroom's own **estimator**, not Anthropic's tokenizer.
- Docs: https://docs.headroomlabs.ai/docs/quickstart, /docs/configuration, /docs/ccr, /docs/limitations. npm README bundled in package.

### Allowed APIs — claude-mem internals (verified file:line)

| Concern | Location |
|---|---|
| SessionStart injection chain | `src/cli/handlers/context.ts:56-174` → `GET /api/context/inject` (`src/services/worker/http/routes/SearchRoutes.ts:285`) → `generateContextWithStats` (`src/services/context/ContextBuilder.ts:191`) → `buildContextOutput` (`:78`) |
| Existing limits (ALL count-based, none token-based) | `ObservationCompiler.ts:69` (SQL LIMIT = `config.totalObservationCount`, default 50), `:120` (sessions, default 10), `:243` (full observations) |
| Request-time config override precedent | `ContextBuilder.ts:202-205` (`input.full` → 999999) |
| Token math (chars/4) | `src/services/context/TokenCalculator.ts:6-12` `calculateObservationTokens(obs)`, `:14-37` `calculateTokenEconomics` ; `CHARS_PER_TOKEN_ESTIMATE = 4` at `src/services/context/types.ts:99` |
| Stats plumbing | `ContextInjectStats` at `ContextBuilder.ts:120-133` (has `tokens_injected`, `tokens_saved_vs_naive`), mapped `:160-173`, telemetry at `SearchRoutes.ts:371-377` |
| Settings: add-a-key pattern (copy `CLAUDE_MEM_CONTEXT_OBSERVATIONS`) | `src/shared/SettingsDefaultsManager.ts:24` (interface) + `:119` (default); `src/services/context/ContextConfigLoader.ts:16` (parse); `src/services/context/types.ts:14-30` (`ContextConfig`); `SettingsRoutes.ts:79-105` (allowlist) + `:165-170` (numeric validation); viewer: `src/ui/viewer/types.ts:70`, `src/ui/viewer/constants/settings.ts:3`, `src/ui/viewer/components/ContextSettingsModal.tsx:243-251` |
| MCP search server (payloads to compress) | `src/servers/mcp-server.ts` — `get_observations`, `search`, `timeline` tools; `session_start_context` at `:562` proxies `/api/context/inject` |
| Handler purity contract | `src/cli/handlers/context.ts:1-6` — no stdout/stderr; enforced by `npm run lint:hook-io` |
| Read-only DB invariant | `tests/context/context-builder-readonly.test.ts` — context path must never create/mutate the DB |
| Build | `npm run build-and-sync`; **never hand-edit** `plugin/scripts/*.cjs` or `plugin/hooks/hooks.json` (build-verified, hard-fails on hand edits) |
| Tests | `bun test tests` ; `npm run test:context` ; unit template `tests/context/token-calculator.test.ts`, integration template `tests/context/context-builder-readonly.test.ts` (child bun process + temp `CLAUDE_MEM_DATA_DIR`) |
| Docs targets | `docs/public/configuration.mdx` (table `:20`, Context Injection section `:198-301`, JSON block `:285-299`); `docs/public/docs.json` "Best Practices" group (slot after `progressive-disclosure`); pre-existing design intent: `docs/public/progressive-disclosure.mdx:596-638` ("Adaptive Index Size", "Cost Forecasting") |

### Anti-patterns (global — apply to every phase)

- Do NOT invent Headroom APIs. Only the signatures quoted above exist. There is no in-process TS compression; do not "polyfill" one.
- Do NOT hand-edit `plugin/scripts/*.cjs`, `plugin/hooks/hooks.json`, `plugin/ui/viewer-bundle.js` — regenerate via `npm run build`.
- Do NOT change `CHARS_PER_TOKEN_ESTIMATE` or the estimator (it's triplicated in `context/types.ts:99`, `worker/FormattingService.ts:6`, `worker/OpenRouterProvider.ts:176` and inlined in SQL at `telemetry/backfill.ts:377`).
- Do NOT add stdout/stderr/console to `src/cli/handlers/context.ts` (purity contract, `lint:hook-io`).
- Do NOT open a writable DB handle anywhere on the context path (read-only invariant).
- Do NOT block session start on Headroom: every Headroom call must have `fallback: true` and a short timeout; the injected context must be produced even if the proxy is down or never installed.
- No try/catch during initial development except where a library option (`fallback`) provides the degradation; error handling is finalized in the last phase.

---

## Phase 1: Deterministic token budget ("headroom") in session-start context

The guarantee layer — works with zero external dependencies. Headroom-the-library skips short structured text (the index) by design, so budget enforcement here must be deterministic and local.

**Implement:**
1. New setting `CLAUDE_MEM_CONTEXT_TOKEN_BUDGET` (string int, default `'0'` = disabled/unlimited). Copy the `CLAUDE_MEM_CONTEXT_OBSERVATIONS` pattern across ALL touch points listed in Phase 0 (SettingsDefaultsManager interface `:24` + default `:119`; `ContextConfig` field `tokenBudget: number` in `types.ts:14-30`; parse in `ContextConfigLoader.ts:16` with `parseInt(..., 10)`; SettingsRoutes allowlist `:79-105` + numeric validation `:165-170`, range 0–200000; viewer types/constants/modal).
2. Budget trim in `buildContextOutput` (`ContextBuilder.ts:78`): after `calculateTokenEconomics` (`:89`) and before rendering (`:93-98`), when `config.tokenBudget > 0`, greedy-fill observations newest-first using `calculateObservationTokens(obs)` (`TokenCalculator.ts:6`) until the budget is reached; drop the remainder from the timeline. Summaries count against the budget via the same chars/4 estimate (`src/shared/timeline-formatting.ts:74-76` `estimateTokens`). Recompute economics on the trimmed set so the `Stats:` line stays truthful.
3. Extend `ContextInjectStats` (`ContextBuilder.ts:120-133`) with `token_budget` and `observations_trimmed_by_budget`; populate in `buildInjectStats` (`:137-174`). Telemetry flows automatically via the `...contextResult.stats` spread (`SearchRoutes.ts:371-377`).
4. Respect the existing `input?.full` override (`ContextBuilder.ts:202-205`): `full=true` also bypasses the token budget (set `config.tokenBudget = 0` there).

**Verification:**
- [ ] `npm run typecheck` clean
- [ ] New unit tests in `tests/context/` (extend `token-calculator.test.ts` style): budget 0 = no trim; budget smaller than one observation still injects header + at least the newest observation; trimmed economics sum ≤ budget; `full=true` bypasses.
- [ ] `npm run test:context` and existing `context-builder-readonly.test.ts` still green (read-only invariant intact).
- [ ] `grep -n "tokenBudget" src/services/context/` shows config field, loader parse, and trim site only.

**Anti-pattern guards:** no SQL changes (trim post-query, keeping the LIMIT 50 fetch as the candidate pool); do not touch renderers' signatures; no new estimator.

---## Phase 2: HeadroomService — TS client wrapper + settings

**Implement:**
1. `npm install headroom-ai` (runtime dep; zero transitive deps).
2. New settings (same add-a-key pattern as Phase 1):
   - `CLAUDE_MEM_HEADROOM_ENABLED` default `'false'` (opt-in; copy boolean pattern `CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT` — `SettingsDefaultsManager.ts:47,142`, `SettingsRoutes.ts:201-208` boolean allowlist)
   - `CLAUDE_MEM_HEADROOM_URL` default `'http://127.0.0.1:8787'`
3. New file `src/services/headroom/HeadroomService.ts` — lazy singleton exposing:
   - `compressPayload(messages: any[], tokenBudget?: number): Promise<CompressResult | null>` — returns `null` immediately when disabled; otherwise `compress(messages, { baseUrl, fallback: true, retries: 1, timeout: 1500, tokenBudget, stack: 'claude-mem' })` copied from the npm README Quick Start.
   - `retrieve(hash: string, query?: string)` via `HeadroomClient.retrieve`.
   - `isHealthy(): Promise<boolean>` via `client.health()`.
   Follow ModeManager's singleton shape (`src/services/domain/ModeManager.ts`).

**Verification:**
- [ ] `npm run typecheck` clean; `bun test tests` green.
- [ ] Unit test: disabled setting → `compressPayload` returns `null` without any network call; enabled + unreachable URL → returns the fallback (original messages, `compressed: false`) within the timeout.
- [ ] `grep -rn "from 'headroom-ai'" src/` hits only `src/services/headroom/`.

**Anti-pattern guards:** only APIs from the Phase 0 Allowed list; no proxy spawning yet (Phase 4); short timeout mandatory — never let a dead proxy stall a hook.

---

## Phase 3: Compress MCP payloads to the primary agent (Headroom's sweet spot)

The heavy tokens reaching the primary agent are `get_observations` / `search` / `timeline` results — JSON/structured payloads where Headroom measures 70–95% savings.

**Implement:**
1. In `src/servers/mcp-server.ts`, at the point each of `get_observations`, `search`, and `timeline` produces its result text/JSON: when `CLAUDE_MEM_HEADROOM_ENABLED`, pass the payload through `HeadroomService.compressPayload([{ role: 'user', content: <payload> }])` and return `result.messages` content; when the result is `null`/`compressed: false`, return the original untouched. Preserve each tool's existing response shape exactly.
2. Add MCP tool `headroom_retrieve` (input: `{ hash: string, query?: string }`) delegating to `HeadroomService.retrieve` — required because CCR markers embedded in compressed payloads instruct the agent to retrieve by hash. Register only when Headroom is enabled.
3. Append compression stats (`tokensBefore/tokensAfter/tokensSaved`) as a single trailing line on compressed responses, mirroring the existing `Stats:` economics style (`AgentFormatter.ts:50-73`).

**Verification:**
- [ ] `npm run test:search` green.
- [ ] Manual: with proxy down + enabled, `get_observations` returns byte-identical output to disabled mode (fallback path).
- [ ] Unit test: `headroom_retrieve` tool absent from the tool list when disabled.
- [ ] `npm run lint:hook-io` clean (no handler contamination).

**Anti-pattern guards:** never compress the session-start index text itself here (Headroom skips <300 t and short prose — wasted latency; the budget from Phase 1 governs that surface); do not alter the stored observations — compression is delivery-time only; remember CCR hashes expire (TTL 1800 s) so `headroom_retrieve` failures must fall back to advising `get_observations([IDs])`.

---

## Phase 4: Proxy lifecycle + doctor

**Implement:**
1. Install path: extend the existing uv-based dependency bootstrap (the same mechanism that provides Python for Chroma — locate it via `grep -rn "uv tool\|uv sync\|ensureUv" src/services src/npx-cli`) to run `uv tool install --python 3.13 "headroom-ai[proxy]"` when `CLAUDE_MEM_HEADROOM_ENABLED` is turned on.
2. Worker startup (`src/services/worker-service.ts`, near `initializeBackground()` `:456-458` where ModeManager loads): when enabled, spawn `headroom proxy --port 8787` as a managed child following the exact supervision pattern used for Chroma's process; skip spawning if `HeadroomService.healthCheck()` already resolves healthy (user-run proxy). NOTE (Phase 2 finding): the shipped `health()` API has no fallback path and REJECTS on network failure — `healthCheck()` returns the raw promise; callers own the degradation.
3. `claude-mem doctor` (`src/npx-cli/commands/doctor*`): report Headroom state — enabled?, binary found (`command -v headroom`), proxy healthy?, last stats from `client.proxyStats()`.

**Verification:**
- [ ] Enabled + no binary → worker still starts, context still injects (fallback), doctor explains what's missing.
- [ ] Enabled + binary → proxy healthy within startup timeout; `curl http://127.0.0.1:8787/stats` responds.
- [ ] Disabled → zero new processes spawned (`pgrep -f "headroom proxy"` empty).

**Anti-pattern guards:** proxy is a sidecar, never a gate — no startup ordering that blocks the SessionStart hook on proxy readiness; bind localhost only; do not adopt `headroom wrap claude` / `ANTHROPIC_BASE_URL` interception (whole-agent traffic rerouting is out of scope for a plugin).

---

## Phase 5: Error-handling pass, docs, verification (FINAL)

**Implement:**
1. Error-handling phase (per project pillars — now, not earlier): wrap HeadroomService network boundaries with structured handling + a rate-limited warn log in the worker (never in hook handlers); ensure every failure path degrades to original content — specifically (Phase 3 review S1): a rejection guard in `maybeCompressToolResponse` so any non-fallback `compress()` rejection returns the original payload instead of converting a good tool result into an error. Includes the tracked Phase 2 review items: (a) `healthCheck()`/`retrieve()` rejection handling at call sites; (b) decide + implement enabled-flag gating for `retrieve()`/`healthCheck()`.
1b. Tracked from Phase 2 review: URL-format validation for `CLAUDE_MEM_HEADROOM_URL` in `SettingsRoutes.validateSettings` (copy the `new URL(...)` check used for `CLAUDE_MEM_OPENROUTER_SITE_URL` at `SettingsRoutes.ts:247-253`; empty string must fall back to the default, not construct a client with `baseUrl: ''`).
1d. Tracked from Phase 4 review (S1): seam tests for HeadroomProxyManager's two riskiest untested branches — (a) binary missing → uv install spawned with exact args `['tool','install','--python','3.13','headroom-ai[proxy]']` then re-resolve; (b) `stop()` with no spawned child never calls killProcessTree (user-run proxy is untouchable). Also N1: reset `stopping = false` at the top of `startInternal`.
1c. Tracked from Phase 2 review: viewer UI controls for `CLAUDE_MEM_HEADROOM_ENABLED` (toggle) and `CLAUDE_MEM_HEADROOM_URL` (text input) — a small "Headroom" section in the settings UI (ContextSettingsModal or the appropriate sibling), so the Phase 5 "viewer renders and persists" check passes.
2. Docs:
   - `docs/public/configuration.mdx`: rows for the three new settings in the Core Settings table (`:20`) and the Context Injection section (`:198-301`) + JSON example (`:285-299`).
   - New page `docs/public/headroom.mdx` (concept + setup + what gets compressed and what deliberately doesn't); add `"headroom"` to the "Best Practices" pages array in `docs/public/docs.json` after `"progressive-disclosure"`. Cite the existing "Adaptive Index Size"/"Cost Forecasting" future-work notes (`progressive-disclosure.mdx:596-638`) as now-implemented.
3. Final sweep:

**Verification checklist:**
- [ ] `npm run typecheck` && `npm run lint:hook-io` && `npm run lint:spawn-env`
- [ ] `bun test tests` (full suite), `npm run test:context`, `npm run test:search`
- [ ] Anti-pattern greps all empty: `grep -rn "headroom" plugin/hooks/hooks.json` (no hand edits); `grep -rn "catch {}" src/services/headroom src/services/context`; `grep -rn "compress(" src/cli/handlers/` (no compression in hook handlers)
- [ ] `npm run build-and-sync`, then start a real session in a test project: context injects with `Stats:` line; with budget set low, timeline is visibly trimmed and stats report the trim; with Headroom enabled+proxy up, `get_observations` returns compressed payload + stats line and `headroom_retrieve` round-trips a hash.
- [ ] Settings viewer renders and persists all three new settings.

**Out of scope (explicitly deferred, do not build):** compressing observer/inference-side transcripts (separate cost problem — its own plan), Headroom proxy traffic interception mode, per-mode budget fields in `ModeConfig`, Cursor/Windsurf/OpenCode injection surfaces, Postgres server runtime (has no context-generation path).

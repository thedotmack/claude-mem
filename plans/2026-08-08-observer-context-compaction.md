# Observer Context Compaction: Bound the Observation Agent's History

**Date:** 2026-08-08
**Status:** Planned
**Scope:** OpenAI-compatible observer providers (OpenRouter + Gemini). The Claude SDK path is explicitly out of scope (see Phase 0, finding F6).

## Problem

Production log evidence (2026-08-08):

```
[INFO] OpenRouter API usage {model=deepseek/deepseek-v4-flash, inputTokens=295700,
       outputTokens=106, totalTokens=295806, costUSD=0.011291, messagesInContext=313}
[WARN] High token usage detected - consider reducing context {totalTokens=295806, ...}
```

`ActiveSession.conversationHistory` is push-only. Every observer query re-sends the entire history (`OpenAICompatibleProvider.ts:110,218,276`), so input tokens grow quadratically with session length. Three compounding defects:

1. **No compaction exists.** The `OpenAICompatibleProvider` class doc (`:38-39`) claims "history truncation" is part of the lifecycle — no such code exists anywhere in `src/` (repo-wide grep verified).
2. **Assistant replies are pushed twice.** The provider pushes at `OpenAICompatibleProvider.ts:173/222/280`, then `processAgentResponse` pushes the identical text again at `ResponseProcessor.ts:293-295`. OpenRouter's 1:1 message mapping (`OpenRouterProvider.ts:182-187`) re-sends both copies on every subsequent query. (Gemini partially masks it via consecutive-same-role merging, `GeminiProvider.ts:274-277`.)
3. **Misleading telemetry/logs.** The 50k-token WARN (`OpenRouterProvider.ts:320-325`) suggests an action no code can take and fires on every request once crossed. `cumulativeInputTokens`/`cumulativeOutputTokens` use a fabricated 70/30 split (`OpenAICompatibleProvider.ts:175-176, 224-225, 282-283`) even when real `inputTokens`/`outputTokens` are present on the result.

## Desired behavior

Before each observer query on the OpenAI-compatible path: if estimated history tokens exceed a trigger threshold (fraction of the observer model's context window), **clear** `conversationHistory` and **re-inject** (a) the continuation prompt and (b) a recent-observations timeline for the session's project, sized to **30% of the model's context window**. Context window resolved live from OpenRouter's models catalogue (`context_length`) with cached lookup and offline fallback.

---

## Phase 0: Documentation Discovery (COMPLETE — findings consolidated here)

Three discovery agents read the relevant subsystems in full. Later phases MUST cite this section rather than re-deriving APIs.

### F1. History lifecycle (who touches `conversationHistory`)

Complete list, verified by repo-wide grep:

| Location | Operation |
|---|---|
| `src/services/worker-types.ts:24` | declaration (`ConversationMessage[]`, roles `'user' \| 'assistant'`) |
| `src/services/worker/SessionManager.ts:127` | init to `[]` |
| `src/services/worker/OpenAICompatibleProvider.ts:105,173,215,222,265,280` | pushes |
| `src/services/worker/OpenAICompatibleProvider.ts:110,218,276` | the ONLY semantic reads — `this.query(session.conversationHistory, config)` |
| `src/services/worker/OpenAICompatibleProvider.ts:136` | `.length` for a log field |
| `src/services/worker/ClaudeProvider.ts:490,528,552` | pushes (write-only; SDK carries its own context) |
| `src/services/worker/agents/ResponseProcessor.ts:293-295` | pushes assistant text (unconditional across providers) |
| `src/services/worker/http/routes/SessionRoutes.ts:129,158` | `.length` for log fields |

Nothing derives observations, dedup, telemetry, or DB writes from history. Clearing it mid-session affects only the next `query()` on the Gemini/OpenRouter path.

### F2. The per-turn hook point

`OpenAICompatibleProvider.runMessageLoop` (`:140-163`): the top of the `for await` body (`:148-156`), before the dispatch at `:158/:160`, is the only place that runs between turns with the full session in hand. This is where compaction goes.

`estimateTokens(text)` is already an abstract member (`:74`) implemented by both providers (`Math.ceil(len/4)`: `OpenRouterProvider.ts:162-164`, `GeminiProvider.ts:240-242` → `src/shared/timeline-formatting.ts:74-77`) — but is currently never called by the base class. Wire it up; do not invent a new estimator.

### F3. Continuation prompt

`buildContinuationPrompt(userPrompt, promptNumber, contentSessionId, mode)` — `src/sdk/prompts.ts:191-214`. Needs `ModeConfig` from `ModeManager.getInstance().getActiveMode()`, which is already resolved once per `startSession` (`OpenAICompatibleProvider.ts:99`) and threaded into `runMessageLoop` as the `mode` arg — the compaction hook already has it. `getActiveMode()` throws if `loadMode()` hasn't run; safe inside the worker (loaded at `worker-service.ts:457`).

### F4. Timeline building blocks (no token budget exists today — must be added)

- Top-level context entry point: `generateContextWithStats(input?, forHuman?)` — `src/services/context/ContextBuilder.ts:171-219`. Config knobs are **counts only** (`ContextConfig`, `src/services/context/types.ts:14-30`); the sole runtime override precedent is the `full` flag hardcoding counts to 999999 (`ContextBuilder.ts:182-185`). No token/char cap exists anywhere on the context path.
- Pure building blocks to compose directly (all in-process, db in hand):
  - `queryObservationsMulti(db, projects, config, platformSource?)` — `src/services/context/ObservationCompiler.ts:20-71` (orders `created_at_epoch DESC`, `LIMIT config.totalObservationCount`)
  - `querySummariesMulti(...)` — `ObservationCompiler.ts:87-122`
  - `prepareSummariesForTimeline(...)` — `ObservationCompiler.ts:205-220`
  - `buildTimeline(observations, summaries)` — `ObservationCompiler.ts:222-238` (pure merge+sort)
  - `getFullObservationIds(observations, count)` — `ObservationCompiler.ts:240-246`
  - `renderTimeline(timeline, fullObservationIds, config, cwd, forHuman)` — `src/services/context/sections/TimelineRenderer.ts:142-157`
  - `calculateObservationTokens(obs)` — `src/services/context/TokenCalculator.ts:6-12` (ceil(chars/4) over title+subtitle+narrative+facts)
  - `loadContextConfig()` — `src/services/context/ContextConfigLoader.ts:7-29`
- `CHARS_PER_TOKEN_ESTIMATE = 4` — `src/services/context/types.ts:99`. Same constant duplicated at `OpenRouterProvider.ts:97`.
- NOTE: `src/services/worker/TimelineService.ts` is NOT the session-start timeline — it is a stateless anchor-windowing helper for the MCP `timeline` tool. Do not use it here.

### F5. Context-window resolution source

- The only models-catalogue fetch in the repo: `fetchBlendedRates()` — `src/npx-cli/cmem-pro-costs.ts:85-118`. Copy this exact pattern: `MODELS_URL = 'https://openrouter.ai/api/v1/models'` (`:24`, no auth), `AbortSignal.timeout(3_000)` (`:30,:88`), non-OK → fallback (`:91`), structural `as` cast on `payload.data` (`:93-98`), map-by-id (`:96-98`), bare-catch fallback (`:114-117`).
- `context_length` is present on the wire per model entry (and `top_provider.context_length`) but is parsed nowhere in the repo today (0 grep hits). **Verify field name against a live `curl https://openrouter.ai/api/v1/models` response before coding** — the discovery agent flagged this as unverified API knowledge.
- No generic cache utility exists. TTL idioms to copy: `src/services/telemetry/telemetry.ts:26-39` (minimal `{value, expiresAt}`) or `src/shared/find-claude-executable.ts:62-67` (with revalidation).
- Gemini has no catalogue; the repo's only per-model metadata table is `GEMINI_RPM_LIMITS` (`GeminiProvider.ts:110-116`) — precedent for a small hardcoded map.

### F6. Provider paths and scope

- OpenRouter: model = `settings.CLAUDE_MEM_OPENROUTER_MODEL` verbatim (default `'xiaomi/mimo-v2-flash:free'`), endpoint may be a custom gateway (`endpointClass: 'openrouter' | 'custom'`, `OpenRouterProvider.ts:159`). Custom gateways: catalogue lookup is meaningless → fallback window.
- Gemini: 5-model allowlist (`GeminiProvider.ts:103-116`); reports real `promptTokenCount`/`candidatesTokenCount` (`:384-389`); role-merge quirk (`:274-277`) means an injected assistant turn adjacent to another assistant turn gets concatenated — compaction re-injection must start with a **user** turn (the continuation prompt is `role: 'user'`, so this is naturally satisfied).
- Claude path: `conversationHistory` is write-only (F1); the SDK subprocess manages its own context; `ClaudeProvider.ts:101-108` only *classifies* "context window" errors as unrecoverable. **No changes to ClaudeProvider in this plan.**
- Existing overflow vocabulary to reuse, not reinvent: `abortReason?: 'overflow'` (`worker-types.ts:40`); Gemini `'context_limit'` categorization (`GeminiProvider.ts:129-175`).

### F7. Settings pattern

Adding `CLAUDE_MEM_*` keys requires (all values are strings, booleans as `'true'`/`'false'`):
1. `SettingsDefaultsManager.ts` interface (`:22-114`) + `DEFAULTS` (`:117-206`).
2. HTTP-writable allowlist: `src/services/worker/http/routes/SettingsRoutes.ts:77-107` (keys absent here cannot be set from the UI).
3. Optional UI mirrors: `src/ui/viewer/types.ts`, `src/ui/viewer/constants/settings.ts`; docs at `docs/public/configuration.mdx`.
Precedent for reading settings mid-lifecycle: `OpenAICompatibleProvider.ts:268-270` + `resolveSummaryTierModel` (`model-aliases.ts:36-41`).

### F8. Token accounting (real vs fabricated)

- Fabricated 70/30 split sites: `OpenAICompatibleProvider.ts:175-176, 224-225, 282-283` (input += `tokensUsed*0.7`, output += `tokensUsed*0.3`).
- Real per-turn numbers already available on `ProviderQueryResult` (`:23-32`): `inputTokens`/`outputTokens` from OpenRouter (`OpenRouterProvider.ts:296-297`) and Gemini (`GeminiProvider.ts:384-389`).
- The only reader of the cumulative fields is `ClaudeProvider.ts:336,:367` (`discoveryTokens` delta) — the OpenAI-compatible path passes `tokensUsed` directly to `processAgentResponse`, so changing the cumulative split does not change stored observation tokens on this path.

### F9. Test scaffolds

- fetch-mock template: `tests/gemini_provider.test.ts:54-60, 167-207, 352, 392-446` (Bun `mock`, `global.fetch` swap with save/restore).
- History assertion that pins single-push semantics: `tests/worker/agents/response-processor.test.ts:948-950` (exactly one assistant entry after `processAgentResponse`).
- Existing provider-lifecycle test: `tests/worker/openai-compatible-summary-tier.test.ts`.
- Context pins: `tests/context/context-builder-readonly.test.ts`, `tests/context/observation-compiler.test.ts`.

### Allowed APIs (exhaustive for this plan)

`buildContinuationPrompt`, `ModeManager.getInstance().getActiveMode()`, `queryObservationsMulti`, `querySummariesMulti`, `prepareSummariesForTimeline`, `buildTimeline`, `getFullObservationIds`, `renderTimeline`, `calculateObservationTokens`, `loadContextConfig`, `SettingsDefaultsManager.loadFromFile`, `logger.{debug,info,warn,error}`, `AbortSignal.timeout`, the abstract `estimateTokens`. **Anti-patterns:** do not call `TimelineService` for this; do not add params to the closed `session_start_context` MCP schema (`mcp-server.ts:585`, `additionalProperties: false`); do not use `fetchWithTimeout` expecting catalogue semantics (`cmem-pro-costs` deliberately uses plain fetch); do not invent a `ContextConfig.tokenBudget` field consumed by existing renderers (nothing reads it).

---

## Phase 1: Truthful accounting and logging (independent, ship first)

Small correctness fixes; each independently verifiable. No behavior change to compaction (which doesn't exist yet).

### 1a. Remove the duplicate assistant push

**What:** Delete the three base-class assistant pushes at `OpenAICompatibleProvider.ts:173, 222, 280` and keep `ResponseProcessor.ts:293-295` as the single push site (this matches the Claude path, where ResponseProcessor is already the only assistant-push).
**Reference:** F1 push-site table; control flow at `OpenAICompatibleProvider.ts:165-187, 220-241, 278-297`.
**Caution:** `processAgentResponse` is called with `obsResponse.content || ''` when `forwardEmptyMessageResponse` (OpenRouter) — `if (text)` in ResponseProcessor already guards the empty case. The token-accounting lines currently inside the same `if (obsResponse.content)` blocks must stay; only the `.push(...)` lines are removed.
**Verify:**
- `grep -n "conversationHistory.push" src/services/worker/OpenAICompatibleProvider.ts` → only the three **user** pushes remain (`:105`-region, obs-prompt, summary-prompt).
- New test (extend `tests/worker/openai-compatible-summary-tier.test.ts` or a sibling): after one observation turn through a stub provider + `processAgentResponse`, history contains exactly one assistant entry with that content. `tests/worker/agents/response-processor.test.ts:948-950` still passes.

### 1b. Real token accounting when the provider reports it

**What:** At the three split sites (`OpenAICompatibleProvider.ts:175-176, 224-225, 282-283`), use `result.inputTokens`/`result.outputTokens` when **both** are numbers (same both-or-nothing contract as `buildLastUsage`, `OpenRouterProvider.ts:171-180`); fall back to the existing 70/30 split of `tokensUsed` otherwise (custom gateways may omit usage). Extract one private helper on the base class so the logic exists once (DRY — three identical sites today).
**Verify:** unit test with a stubbed `ProviderQueryResult {tokensUsed: 1000, inputTokens: 950, outputTokens: 50}` → cumulative input +950/output +50; with `inputTokens` undefined → +700/+300.

### 1c. Fix the misleading WARN and the false docstring

**What:**
- Delete the `tokensUsed > 50000` WARN block (`OpenRouterProvider.ts:320-325`). Its replacement is the compaction INFO log added in Phase 4 (which reports an action actually taken). Keep the INFO usage line (`:311-318`) unchanged — it is accurate and useful.
- Rewrite the `OpenAICompatibleProvider` class doc (`:34-42`): drop "history truncation" now; Phase 4 re-adds a truthful "history compaction" clause when it exists.
**Verify:** `grep -rn "High token usage detected" src/` → 0 hits. `grep -n "history truncation" src/services/worker/OpenAICompatibleProvider.ts` → 0 hits.

**Anti-pattern guards (Phase 1):** no try/catch additions; no new settings; do not touch `ClaudeProvider` accounting (`:338-365` is real usage already).

---

## Phase 2: Context-window resolution

New module `src/services/worker/context-window.ts`.

**What to implement:**

1. `export async function resolveContextWindowTokens(provider: 'openrouter' | 'gemini', model: string, endpointClass?: 'openrouter' | 'custom'): Promise<number>`
2. OpenRouter + `endpointClass === 'openrouter'`: fetch the catalogue **copying `cmem-pro-costs.ts:85-118` exactly** — `https://openrouter.ai/api/v1/models`, `AbortSignal.timeout(3_000)`, `Accept: application/json`, non-OK → fallback, structural cast widened to `Array<{ id?: string; context_length?: number }>`, map-by-id, bare-catch → fallback. First: verify the field name with one live `curl` (F5 flags it unverified) and record the observed shape in a code comment.
3. Module-level TTL cache copying `telemetry.ts:26-39` (`{ value, expiresAt }`, suggest 1h TTL). One catalogue fetch per worker-hour, not per query.
4. Fallbacks (constants in this module):
   - `FALLBACK_CONTEXT_WINDOW_TOKENS = 131_072` — custom gateways, unknown models, offline.
   - Gemini: small hardcoded map keyed by the 5-entry `GeminiModel` allowlist (`GeminiProvider.ts:103-108`), precedent `GEMINI_RPM_LIMITS` (`:110-116`); unknown → fallback.
5. Settings override `CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW` (default `''` = auto). Non-empty parsed int short-circuits all lookups. Declare per F7 (interface + DEFAULTS + `SettingsRoutes.ts` allowlist).

**Verification checklist:**
- Unit tests (fetch-mock scaffold from `tests/gemini_provider.test.ts:167-207`): catalogue hit → its `context_length`; model missing → fallback; non-OK/timeout/offline → fallback, no throw; second call within TTL → no second fetch (assert mock call count); settings override wins.
- `grep -n "context_length" src/services/worker/context-window.ts` → present; nowhere else outside the npx-cli file.

**Anti-pattern guards:** no retry loop (single attempt + fallback, like pricing); never throw from resolution (an offline worker must observe normally); do not import from `src/npx-cli/` into worker code (copy the pattern, not the module — npx-cli is a separate entry point).

---

## Phase 3: Token-budgeted timeline builder

New module `src/services/worker/observer-compaction.ts` (worker-side, has `DatabaseManager` in hand; do NOT route through HTTP or MCP).

**What to implement:**

`export function buildCompactionTimeline(db: { db: Database }, project: string, cwd: string, tokenBudget: number): string`

Compose F4's pure functions:
1. `const config = loadContextConfig()` (`ContextConfigLoader.ts:7-29`), then override `config.totalObservationCount` to a generous ceiling (e.g. 500) — copying the `full`-flag override precedent at `ContextBuilder.ts:182-185`.
2. `queryObservationsMulti(db, [project], config)` → newest-first observations.
3. Budget → count conversion (the piece that exists nowhere today, F4): walk newest→oldest accumulating `calculateObservationTokens(obs)` (`TokenCalculator.ts:6-12`); keep observations while cumulative ≤ `tokenBudget`.
4. `querySummariesMulti` + `prepareSummariesForTimeline` + `buildTimeline(kept, summaries)` + `renderTimeline(timeline, getFullObservationIds(kept, config.fullObservationCount), config, cwd, /*forHuman*/ false)` — exact assembly order copied from `buildContextOutput` (`ContextBuilder.ts:84-93`).
5. Return the joined string (`output.join('\n').trimEnd()` idiom, `ContextBuilder.ts:107`).

**Verification checklist:**
- Unit test with a seeded in-memory DB (pattern from `tests/context/observation-compiler.test.ts`): budget large → all observations present; budget tiny → only newest survive; estimated tokens of returned string (`chars/4`) ≤ ~1.2× budget (renderer adds headers/day-grouping overhead — assert a tolerance, not exactness).
- Returned string is BMP-safe if it flows through any path that requires it — it does not (worker→provider request body only), so no `toBmpSafe` call. Confirm by citing F1 (history is never written to CLAUDE.md paths).

**Anti-pattern guards:** do not add a `tokenBudget` field to `ContextConfig` (nothing else would read it — YAGNI); do not call `generateContextWithStats` (it fires `context_injected`-adjacent stats and loads its own DB); do not use `TimelineService.filterByDepth` (wrong abstraction, F4 note).

---

## Phase 4: The compaction hook

**What to implement — all in `OpenAICompatibleProvider.ts`:**

1. Constants at module top: `COMPACT_TRIGGER_RATIO = 0.7`, `REINJECT_BUDGET_RATIO = 0.3` (the user-specified 30%).
2. Resolve the window once per session: in `startSession` after `getConfig()` (`:82-86`), `const contextWindowTokens = await resolveContextWindowTokens(...)` (Phase 2), stored on a private field or threaded as a param alongside `config` into `runMessageLoop`. Provider identity: `this.syntheticIdPrefix` (`'openrouter' | 'gemini'`); `endpointClass` from `session.endpointClass` (set by `prepareSessionExtras`, `OpenRouterProvider.ts:156-160` — note it runs at `:86`, before the resolution call, so ordering works).
3. New private method `maybeCompactHistory(session, mode, contextWindowTokens)`, called at the top of the `for await` body in `runMessageLoop` (`:148-156`, before the `:158/:160` dispatch):
   - Estimate: `this.estimateTokens(session.conversationHistory.map(m => m.content).join(''))` — finally wiring the dormant abstract member (F2).
   - If estimate ≤ `contextWindowTokens * COMPACT_TRIGGER_RATIO` → return.
   - Else: record `beforeMessages`/`beforeTokens`; `session.conversationHistory.length = 0`; push `{ role: 'user', content: buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode) + '\n\n<recent_project_timeline>\n' + buildCompactionTimeline(this.dbManager.getSessionStore()… /* per Phase 3 signature */, session.project, cwd, Math.floor(contextWindowTokens * REINJECT_BUDGET_RATIO)) + '\n</recent_project_timeline>' }`. Starting with a user turn satisfies the Gemini role-merge constraint (F6).
   - `logger.info('SDK', 'Observer history compacted', { sessionId, beforeMessages, beforeTokens, afterTokens, contextWindowTokens })` — this is the truthful replacement for the deleted Phase-1c WARN.
4. Kill switch: `CLAUDE_MEM_OBSERVER_COMPACTION_ENABLED` (default `'true'`), read via `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` at the hook (mid-lifecycle settings-read precedent: `:268-270`). Declare per F7 (interface + DEFAULTS + SettingsRoutes allowlist), alongside Phase 2's `CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW`.
5. Restore the class-doc clause removed in 1c, now truthfully: "history compaction (clear + timeline re-injection) when estimated history exceeds 70% of the model context window".

**Documentation references:** hook point F2; prompt F3; role-merge constraint F6; settings F7.

**Verification checklist:**
- Unit test with a stub subclass of `OpenAICompatibleProvider` (pattern: `tests/worker/openai-compatible-summary-tier.test.ts`): feed history past the trigger → next observation query receives history of length 2 (compacted user turn + new obs prompt… verify exact expectation against implementation), containing `<recent_project_timeline>`; below trigger → untouched; setting `'false'` → untouched.
- Cost regression scenario: simulate 40 observation turns with ~2k-token replies against a 131k window — assert history token estimate never exceeds `0.7 * 131072 + one turn` at query time.
- `npm run build-and-sync` and drive a real session (per repo `/run` conventions); confirm the "Observer history compacted" INFO appears in worker logs on a long session and observations continue to store afterward (check `~/.claude-mem/claude-mem.db` observation rows advance past the compaction timestamp).

**Anti-pattern guards:** compaction must be synchronous-in-loop (no fire-and-forget promise — the next query must see the compacted history); do not compact inside `processSummaryMessage`'s flow after its push (the check runs before dispatch, covering both message types); no try/catch around `buildCompactionTimeline` in initial development — a throwing timeline builder should fail the turn visibly (Fail Fast; the message-loop error handler at `:123-130` already reports it).

---

## Phase 5: Final verification

1. **Doc-conformance sweep:** every API call in the diff appears in Phase 0's Allowed APIs list; `context_length` parse matches the shape recorded from the live curl in Phase 2.
2. **Anti-pattern greps:**
   - `grep -rn "High token usage detected" src/` → 0
   - `grep -rn "conversationHistory.push" src/services/worker/ src/services/worker/agents/` → exactly: 3 user-pushes in `OpenAICompatibleProvider`, 3 in `ClaudeProvider`, 1 assistant-push in `ResponseProcessor`, plus the compaction re-inject push
   - `grep -rn "0.7\|0.3" src/services/worker/OpenAICompatibleProvider.ts` → only the named ratio constants and the 70/30 fallback helper
   - `grep -rn "tokenBudget" src/services/context/` → 0 (budget logic stays in the worker module)
3. **Tests:** `bun test tests/worker tests/context tests/gemini_provider.test.ts` green; the Phase 1a/1b/2/3/4 tests all present.
4. **Live check:** long observer session on OpenRouter; confirm log sequence shows `messagesInContext` reset after compaction and per-request `inputTokens` bounded near `0.7 × window`, and post-compaction observations still reference earlier session work plausibly (timeline context doing its job).
5. Update `docs/public/configuration.mdx` with the two new settings keys.

---

## Rollout notes

- Phase 1 is independently shippable and cuts token growth roughly in half on OpenRouter (removes the duplicate assistant copies) before compaction even lands.
- Phases 2–4 are sequential (4 depends on 2 and 3).
- No DB migrations, no MCP schema changes, no ClaudeProvider changes.
- New settings: `CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW` (default `''` = auto), `CLAUDE_MEM_OBSERVER_COMPACTION_ENABLED` (default `'true'`).

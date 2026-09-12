# Claude-Mem Cleanup Execution Plan — 2026-04-19

**Supersedes**: `SIMPLIFICATION-PLAN-2026-04-19.md` (which supersedes the execution table in `ARCHITECTURE-AUDIT-2026-04-19.md`). Both remain in the tree as historical context. **This document is the single source of truth for the PR.**

**Scope**: Phases 1–5 of the audit (fast path) — ~1,340 LOC net deletion, zero feature regressions, fixes the luma SIGTERM incident, kills the FTS5 write tax, collapses the 9-class context pipeline.

**Out of scope (explicitly deferred)**: Phases 6–13 — see bottom section.

---

## 0. Branch & merge strategy

### 0.1 Base

- Execution branch: **`shrouded-toucan`** (current HEAD `8800ee7a docs: add architecture audit and simplification plan`).
- shrouded-toucan is 22+ commits ahead of `main`, carrying Layer 3 / TITANS conversation work + the audit docs.
- `main` holds v12.3.2 (PR #2079 — FTS5 caching, docker, search fixes merged) — we do NOT need any of that; Phase 4 deletes FTS5 outright.
- PR #2080 (`issue-blowout-2026`) is **OPEN**, passing Greptile, CodeRabbit pending, `mergeStateStatus: DIRTY` against main. It is orthogonal to this cleanup (security hardening + worker stability).

### 0.2 Conflict posture with PR #2080

PR #2080 touches a handful of files this plan also touches, but in **additive, non-overlapping ways**:

| File | PR #2080 change | Our change | Conflict? |
|---|---|---|---|
| `SessionRoutes.ts` | Bearer auth middleware + project filter in search routes | Delete drain at `:122-124` | No — different regions |
| `SearchManager.ts` | Project filter propagation in `findBy*` | 3 null-guards at top of `findBy*` | Textual overlap at top of methods; trivial manual merge |
| `SessionManager.ts` | Idle eviction callback (new methods) | Collapse 4 `count*` methods to `getQueueStatus()` | No — different methods |
| `PendingMessageStore.ts` | `clearFailed()` purge | Delete `markAllSessionMessagesAbandoned`, collapse 4 resets, ack→DELETE | Logical overlap (Phase 3 removes the "failed" terminal state #2080's `clearFailed` purges — if #2080 lands first, `clearFailed` becomes dead code in Phase 3 and must be deleted) |
| `worker-service.ts` | `RestartGuard`, `ProcessRegistry` wiring | Delete 2 drain sites, unify `getActiveAgent()` | No — different regions |

**Strategy**: work the cleanup on `shrouded-toucan` in parallel with #2080. Whichever lands into `main` first, the other rebases. The conflict footprint is small (est. 6–10 minutes of manual merge) because the simplification is mostly deletions.

### 0.3 Ordering rule

One commit per phase. Never batch phases. Each commit passes its own verification before the next begins. Phase 1 has a mandatory luma-container smoke test before any `npm run build-and-sync` to the marketplace.

---

## Phase 0 — Pre-verified ground truth

All file paths + line numbers below were re-verified against `shrouded-toucan` on 2026-04-19. Do not re-audit — start implementing.

### Phase 1 targets
| Site | Path:Line | Current content |
|---|---|---|
| Drain #1 (session complete) | `src/services/worker/session/SessionCompletionHandler.ts:35-54` | `try { … markAllSessionMessagesAbandoned … } catch { … }` |
| Drain #2 (no fallback) | `src/services/worker-service.ts:909-917` | `const abandoned = pendingStore.markAllSessionMessagesAbandoned(…); if (abandoned > 0) logger.warn(…)` |
| Drain #3 (terminateSession) | `src/services/worker-service.ts:932-944` | body opens with `pendingStore.markAllSessionMessagesAbandoned(…)` then `logger.info('Session terminated', … abandonedMessages …)` |
| Drain #4 (wall-clock guard) | `src/services/worker/http/routes/SessionRoutes.ts:122-124` | `pendingStore.markAllSessionMessagesAbandoned(sessionDbId);` |
| Definition | `src/services/sqlite/PendingMessageStore.ts:287-302` | JSDoc + method body |
| Parser fallback | `src/sdk/parser.ts:56-68` | `fallbackType = validTypes[0]` / `finalType = fallbackType` / `if (type) …else logger.error('missing type field')` |
| Chroma null-guard sites | `src/services/worker/SearchManager.ts:1099, 1167, 1289` | `findByConcept` / `findByFile` / `findByType` |
| Test refs | `tests/zombie-prevention.test.ts:346, 361, 373, 377, 413, 414, 415, 429, 453, 473` + `tests/worker/session-lifecycle-guard.test.ts:158` | Assertions on `markAllSessionMessagesAbandoned(…)` |
| Doc ref | `docs/architecture-overview.md:81` (lifecycle diagram) | mentions `markAllSessionMessagesAbandoned` |

### Phase 2 targets
| Site | Path:Line |
|---|---|
| Prompt builders | `src/sdk/prompts.ts:43` (`buildInitPrompt`), `:198` (`buildContinuationPrompt`) |
| Per-agent call sites | `SDKAgent.ts:352-353`, `GeminiAgent.ts:157-158`, `OpenRouterAgent.ts:108-109` |
| Agent selectors | `src/services/worker-service.ts:633-648` (silent fallback variant), `src/services/worker/http/routes/SessionRoutes.ts:57-70` (throwing variant) |

### Phase 3 targets — AMENDED (see §3 for rationale)
| Site | Path:Line | Category |
|---|---|---|
| Ack write #1 | `src/services/sqlite/transactions.ts:133-143` | `UPDATE … SET status='processed' WHERE id = ? AND status='processing'` |
| Ack write #2 | `src/services/sqlite/SessionStore.ts:2239` | `status = 'processed'` |
| `'processed'` reader | `src/services/sqlite/PendingMessageStore.ts:326-342` (`getRecentlyProcessed`) |
| UI consumer | `src/services/worker/http/routes/DataRoutes.ts:434` (`pendingStore.getRecentlyProcessed(20, 30)`) |
| CHECK constraints | `SessionStore.ts:566`, `migrations/runner.ts:536`, `:1108` | all declare `status IN ('pending','processing','processed','failed')` |
| Enum | `PendingMessageStore.ts:22` (type union) |
| Four reset collapse | `PendingMessageStore.ts:166 resetStaleProcessingMessages`, `:256 resetProcessingToPending`, `:316 retryAllStuck`, `:381 resetStuckMessages` |
| Four count collapse | `SessionManager.ts:585 hasPendingMessages`, `:599 getTotalQueueDepth`, `:612 getTotalActiveWork`, `:622 isAnySessionProcessing` |
| Count readers | `worker-service.ts:1094` `getTotalActiveWork`; `ViewerRoutes.ts:101-102`, `DataRoutes.ts:306-307, :319-320` |
| `markSessionMessagesFailed` | `PendingMessageStore.ts:271-285` (delete — unused after Phase 1) |

### Phase 4 targets (FTS5 deletion)
| File | Scope |
|---|---|
| `src/services/sqlite/SessionSearch.ts` | Delete lines `61` (hasFTS detection), `106-185` (observations_fts + session_summaries_fts creation + 6 triggers), `290` (`buildOrderClause` fts branch). Audit the whole file; the header comment at `:21-22, 40-56` already flags FTS as dead. |
| `src/services/sqlite/SessionStore.ts` | Delete `:452-486` (user_prompts_fts + 3 triggers), `:748-765` (observations triggers), `:811-826` (session_summaries triggers), `:855` + `:869` (hasFTS branches), `:2819-2830` (FTS rebuild) |
| `src/services/sqlite/migrations.ts` | Delete `:379-478` (FTS creation + 6 triggers), keep `DROP TABLE IF EXISTS` at `:478-483` **inside the new drop-FTS migration** |
| `src/services/sqlite/migrations/runner.ts` | Delete `:427`, `:445-465+` (user_prompts_fts creation + triggers) |
| NEW migration | `src/services/sqlite/migrations/M-drop-fts5.ts` — drops 6 triggers + 3 virtual tables |

### Phase 5 targets (context pipeline collapse)
| File | LOC |
|---|---|
| `src/services/context/ContextBuilder.ts` | 187 |
| `src/services/context/ContextConfigLoader.ts` | 40 |
| `src/services/context/ObservationCompiler.ts` | 343 |
| `src/services/context/TokenCalculator.ts` | 78 |
| `src/services/context/types.ts` | 142 |
| `src/services/context/index.ts` | 18 (export barrel) |
| `src/services/context/formatters/AgentFormatter.ts` | 227 |
| `src/services/context/formatters/HumanFormatter.ts` | 238 |
| `src/services/context/sections/FooterRenderer.ts` | 42 |
| `src/services/context/sections/HeaderRenderer.ts` | 61 |
| `src/services/context/sections/SummaryRenderer.ts` | 65 |
| `src/services/context/sections/TimelineRenderer.ts` | 183 |
| **Total** | **1,624** |

Callers: `src/services/context-generator.ts`, `src/services/worker/FormattingService.ts`, `src/services/worker/http/routes/SearchRoutes.ts`, `src/shared/timeline-formatting.ts`, `src/services/sqlite/SessionStore.ts`.

### Build + smoke-test commands

```bash
# Iterative: host build, container restart
npm run build                                        # regenerates plugin/ (bind-mounted into dev container)
docker exec claude-mem-dev bash -c \
  'pkill -f worker-service.cjs; \
   exec bun /opt/claude-mem/scripts/worker-service.cjs \
        >> ~/.claude-mem/logs/worker.log 2>&1 &'

# Typecheck + tests (host)
npx tsc --noEmit
npm test

# After Phase 1 passes smoke test (NOT before):
npm run build-and-sync                               # pushes to marketplace
```

The dev container is `claude-mem-dev` (per `CLAUDE.md`) OR `claude-mem-luma` if that's what you have running. Both containers exist today. Pick whichever is attached to this worktree's bind-mount — verify with `docker inspect claude-mem-dev | grep -i shrouded-toucan` before restarting.

---

## Phase 1 — Incident fix (~55 LOC)

**Goal**: stop flipping pending rows to `failed` when a session dies. Stop emitting observations with mode-fallback types when the SDK omits `<type>`. Stop passing `undefined` to Chroma. **One commit.**

**Why first**: this alone fixes the luma incident (68 rows lost to `failed`, 4 null-type observations). Everything else is followup cleanup.

### 1A. Delete the drain (4 sites)

**Edit `src/services/worker/session/SessionCompletionHandler.ts`** — delete lines **35–54** (the entire `try { … } catch { … }` block including the leading comment). After the edit `completeByDbId` body is:

```typescript
async completeByDbId(sessionDbId: number): Promise<void> {
  this.dbManager.getSessionStore().markSessionCompleted(sessionDbId);
  await this.sessionManager.deleteSession(sessionDbId);
  this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
}
```

Remove the `import { logger } from '../../../utils/logger.js';` line if no other use remains — verify with grep before removing. Remove `DatabaseManager` import only if `dbManager` becomes unused (it's still used for `getSessionStore()`).

**Edit `src/services/worker-service.ts`**:

1. At `:909-917` (no-fallback branch): delete the `const pendingStore = …` + `const abandoned = …` + `if (abandoned > 0) logger.warn(…)` lines. Keep `removeSessionImmediate` and `broadcastSessionCompleted`. Final block:
   ```typescript
   // No fallback or both failed: leave pending messages for future recovery
   this.sessionManager.removeSessionImmediate(sessionDbId);
   this.sessionEventBroadcaster.broadcastSessionCompleted(sessionDbId);
   ```

2. At `:932-944` (`terminateSession`): delete the `pendingStore` + `abandoned` lines. Drop the `abandonedMessages` field from the logger call. Final method:
   ```typescript
   private terminateSession(sessionDbId: number, reason: string): void {
     logger.info('SYSTEM', 'Session terminated', { sessionId: sessionDbId, reason });
     this.sessionManager.removeSessionImmediate(sessionDbId);
   }
   ```

**Edit `src/services/worker/http/routes/SessionRoutes.ts`** — delete lines `:122-123` (the `const pendingStore = …` + `pendingStore.markAllSessionMessagesAbandoned(sessionDbId);` pair). Keep `session.abortController.abort()` at `:120` and `removeSessionImmediate(sessionDbId)` at what becomes `:122` after the deletion.

**Edit `src/services/sqlite/PendingMessageStore.ts`** — delete the entire `markAllSessionMessagesAbandoned` method (lines **287–302**, including JSDoc block).

> **DO NOT** add `DELETE FROM pending_messages` cleanup in this phase. Phase 3's ack→DELETE change handles row cleanup. For now, pending rows survive session completion; the queue picks them up later (or gets reaped by `clearFailed` if it lands from #2080).

### 1B. Parser strictness

**Edit `src/sdk/parser.ts`** in `parseObservations` (lines `:33-111`):

Replace lines `:56-69` (the `fallbackType` / `finalType` / `if (type) { … } else { … }` block) with:

```typescript
    // Strict type validation — reject observations with no valid type.
    // Rationale: mode-first fallback hid SDK regressions (luma incident:
    // 4 bare <observation/> responses silently classified as "bugfix").
    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);

    if (!type || type.trim() === '') {
      logger.error('PARSER', 'Observation has no type — rejecting', { correlationId });
      continue;
    }
    const trimmedType = type.trim();
    if (!validTypes.includes(trimmedType)) {
      logger.error('PARSER', `Invalid observation type "${trimmedType}" — rejecting`, { correlationId, validTypes });
      continue;
    }
    const finalType = trimmedType;
```

Downstream code at `:74, :79, :93, :99` still uses `finalType` unchanged.

After the `while` loop (current `:108`), before `return observations;` at `:110`, insert:

```typescript
  if (observations.length === 0 && text.trim().length > 100) {
    logger.warn(
      'PARSER',
      'Large response produced zero observations — possible SDK format drift',
      { correlationId, rawSnippet: text.slice(0, 500) }
    );
  }
```

**Do not** modify `coerceObservationToSummary` (`:222`). Add a single-line comment above its declaration:

```typescript
// TODO(cleanup-phase-2-followup): band-aid for parseSummary prompt drift — delete when #1633 is properly fixed.
```

### 1C. Chroma null guards

**Edit `src/services/worker/SearchManager.ts`** — insert one guard at the top of each method, immediately after the destructure/normalize step, before any `await this.queryChroma(…)` call.

- `findByConcept` (`:1099`) — after the destructure at `:1101`:
  ```typescript
  if (!concept || (typeof concept === 'string' && concept.trim() === '')) {
    return { content: [{ type: 'text' as const, text: 'Concept is required' }] };
  }
  ```
- `findByFile` (`:1167`) — after the `filePath` normalize at `:1171`:
  ```typescript
  if (!filePath || (typeof filePath === 'string' && filePath.trim() === '')) {
    return { content: [{ type: 'text' as const, text: 'File path is required' }] };
  }
  ```
- `findByType` (`:1289`) — after the destructure at `:1292`:
  ```typescript
  if (!type || (typeof type === 'string' && type.trim() === '') || (Array.isArray(type) && type.length === 0)) {
    return { content: [{ type: 'text' as const, text: 'Type is required' }] };
  }
  ```

Return shape must be `{ content: [{ type: 'text' as const, text: '…' }] }` — MCP expects this exact form. **Do not** use `res.status(400)`; `SearchManager` is not an Express handler.

### 1D. Tests + docs

**`tests/zombie-prevention.test.ts`** — 10 assertion sites (see §0 table). Decision per test:
- If the test's name/intent is "asserts the drain fires" → **delete the test**.
- If the test's intent is "zombie sessions are prevented" → rewrite the assertion to check pending rows **stay `pending`** (or `processing`) after session completion, not `failed`.

**`tests/worker/session-lifecycle-guard.test.ts:158`** — update the simulation comment and assertion: pending rows are NOT marked failed on SIGTERM.

**`docs/architecture-overview.md:81`** — remove the `markAllSessionMessagesAbandoned(sessionDbId)` call from the lifecycle diagram. Replace with a note like "On session completion, pending rows are left for future retry (no drain)."

### 1E. Verification gate (sequential — must all pass)

1. `npm run build` — clean. Any TypeScript error blocks the phase.
2. `npx tsc --noEmit` — clean.
3. `npm test -- tests/zombie-prevention.test.ts tests/worker/session-lifecycle-guard.test.ts` — all pass.
4. `npm test` — full suite clean.
5. **Restart worker in dev container** using the command in Phase 0.
6. **SIGTERM scenario**: drive ≥10 observations into the container, then kill the SDK subprocess:
   ```bash
   docker exec claude-mem-dev bash -c 'pkill -TERM -f "claude.*--print"'
   ```
   Inspect queue state:
   ```bash
   docker exec claude-mem-dev sqlite3 ~/.claude-mem/claude-mem.db \
     "SELECT status, COUNT(*) FROM pending_messages GROUP BY status"
   ```
   **Expected**: rows in `pending` or `processing`, zero in `failed` (unless `markFailed`'s normal retry path hit maxRetries for one). Restart the worker → stale `processing` rows reset to `pending` and get picked up.
7. **Chroma null-path**: hit the MCP tool with no filter:
   ```bash
   curl -sS -X POST 'http://localhost:37778/api/mcp/tool/find_by_file' \
     -H 'Content-Type: application/json' -d '{}'
   ```
   **Expected**: `{"content":[{"type":"text","text":"File path is required"}]}`, HTTP 200. No Pydantic traceback in `~/.claude-mem/logs/worker.log`.
8. **Parser strictness**: submit a test observation with missing `<type>`:
   ```bash
   docker exec claude-mem-dev bash -c 'echo "<observation><title>test</title></observation>" | …' 
   ```
   (or run the parser unit test you added). **Expected**: `logger.error('PARSER', 'Observation has no type — rejecting', …)` in the log; zero observations stored; no `bugfix`-typed ghost observations in the viewer.

**Only after all 8 pass**: commit.

### 1F. Commit

```
fix: stop draining pending messages on session death (cleanup phase 1)

- Delete markAllSessionMessagesAbandoned + 4 call sites (drain bug).
  On session death, pending messages stay pending for future retry.
- Parser: reject observations with missing/invalid type (was: mode-fallback).
  Prevents ghost observations from SDK format drift.
- SearchManager: null-guard filters for findByConcept/File/Type.
  Prevents Pydantic crash on empty MCP calls.
- Tests + docs updated to reflect pending-stays-pending semantics.

Fixes luma incident (2026-04-19): 68 rows to `failed` on SIGTERM.
```

### 1G. Anti-pattern guards (Phase 1)
- Do NOT introduce a new "mark pending rows X" helper to replace the drain.
- Do NOT add a TODO to "restore the drain later." If retry creates pain, fix it in Phase 3.
- Do NOT catch/rethrow the parser's strict reject with a fallback. `continue` is the contract.
- Do NOT return `res.status(400)` from the Chroma guards — SearchManager is called from MCP, not Express.
- Do NOT delete `markFailed` in this phase — it's still used by the normal retry path. Phase 3 evaluates its fate.
- Do NOT touch `coerceObservationToSummary` beyond the TODO comment.

### 1H. Post-commit: update the audit
Flip Phase 1's row in `ARCHITECTURE-AUDIT-2026-04-19.md:124-138` to `✅ Done`.
Then `npm run build-and-sync` to push to the marketplace.

---

## Phase 2 — Prompt + agent-selector dedup (~125 LOC)

**Goal**: one `buildPrompt(session, mode, isFirst)` for init/continuation. One `getActiveAgent()` shared between `worker-service.ts` and `SessionRoutes.ts`, with the **throw-on-missing** behavior (not silent SDK fallback).

### 2A. Collapse prompt builders

**Edit `src/sdk/prompts.ts`**:

1. Read both functions (`:43` `buildInitPrompt`, `:198` `buildContinuationPrompt`) to confirm they differ by ≤5 meaningful lines before collapsing.
2. Write a new exported function `buildPrompt(project, contentSessionId, userPrompt, promptNumber, mode)` at the end of the file. Internally branch on `promptNumber === 1` to produce the init vs continuation body.
3. Make `buildInitPrompt` and `buildContinuationPrompt` **unexported** (keep as private helpers called by `buildPrompt`), OR inline them into `buildPrompt` if the branch body is small. Preserve all existing callers' behavior bit-for-bit.
4. Remove the `export` keyword from both old functions. The only export from the file's "prompt-entry" surface is now `buildPrompt` (plus unrelated exports like `buildObservationPrompt`, `buildSummaryPrompt`, `buildConversationObservationPrompt` — leave those alone).

**Edit all 3 agent call sites** — change from the ternary to a single `buildPrompt` call:

- `src/services/worker/SDKAgent.ts:352-353`:
  ```typescript
  const prompt = buildPrompt(session.project, session.contentSessionId, session.userPrompt, session.lastPromptNumber, mode);
  ```
- `src/services/worker/GeminiAgent.ts:157-158`: same replacement.
- `src/services/worker/OpenRouterAgent.ts:108-109`: same replacement.

Update the `import` statement in each agent to pull `buildPrompt` instead of `buildInitPrompt, buildContinuationPrompt`.

### 2B. Unify `getActiveAgent`

**Create `src/services/worker/AgentSelector.ts`** (~40 LOC):

```typescript
import { logger } from '../../utils/logger.js';
import { SDKAgent } from './SDKAgent.js';
import { GeminiAgent } from './GeminiAgent.js';
import { OpenRouterAgent } from './OpenRouterAgent.js';
import { isGeminiAvailable } from '../../shared/gemini-config.js';
import { isOpenRouterAvailable } from '../../shared/openrouter-config.js';

export function selectActiveAgent(
  sdk: SDKAgent,
  gemini: GeminiAgent,
  openrouter: OpenRouterAgent,
  providerPreference?: string
): SDKAgent | GeminiAgent | OpenRouterAgent {
  // Copy the body of SessionRoutes.ts:57-70 (the THROWING variant).
  // Do NOT copy worker-service.ts:635 — silent fallback hides misconfig.
}
```

Use the throwing variant as the authoritative behavior. If no provider is configured, **throw** — the silent SDK fallback in `worker-service.ts:635` was a band-aid that hid the luma "OpenRouter never configured → silent SDK dependency" class of bug.

**Edit `src/services/worker-service.ts:633-648`** — delete the private `getActiveAgent()` method. Replace call sites (e.g., `:657 const agent = this.getActiveAgent();`) with `const agent = selectActiveAgent(this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.getSelectedProvider());`. Import `selectActiveAgent` at top of file.

**Edit `src/services/worker/http/routes/SessionRoutes.ts:57-70`** — same pattern: delete the private method, import + call `selectActiveAgent`.

### 2C. Verification
1. `npm run build` clean.
2. `npx tsc --noEmit` clean.
3. `npm test` — especially agent-selection + provider-switching tests. If the suite has snapshot tests for prompt text, they must be unchanged.
4. Grep confirmation:
   ```
   rg "buildInitPrompt|buildContinuationPrompt" src/
   ```
   Should return **zero** matches outside of `src/sdk/prompts.ts` itself (and even there, only as unexported helpers if you kept them as private functions).
5. Smoke: start a fresh session (first prompt) and drive a continuation through each configured provider. Confirm observations still appear in the viewer.

### 2D. Commit

```
refactor: unify prompt builder and agent selector (cleanup phase 2)

- Collapse buildInitPrompt + buildContinuationPrompt into one buildPrompt().
- Extract selectActiveAgent() to its own module; delete the two duplicates
  in worker-service.ts and SessionRoutes.ts.
- Authoritative behavior: throw when no provider is configured. Silent SDK
  fallback hid the luma "OpenRouter never configured" class of bug.
```

### 2E. Anti-pattern guards (Phase 2)
- Do NOT keep both `buildInitPrompt` / `buildContinuationPrompt` public. Delete the exports.
- Do NOT "ease" `selectActiveAgent` with a `console.warn` silent fallback. Throw.
- Do NOT create a class `AgentSelector`. Export a function.

---

## Phase 3 — Queue state machine simplification (~90 LOC, AMENDED)

**Goal**: delete the `'processed'` status by flipping ack semantics from **UPDATE-to-processed** → **DELETE row**. Collapse 4 reset methods to one. Collapse 4 count methods to one. Delete `markSessionMessagesFailed`.

### 3A. AMENDMENT: `'processed'` is NOT dead (plan correction)

The original simplification plan (`SIMPLIFICATION-PLAN-2026-04-19.md:216-221`) claimed `'processed'` was "never written by any code." **That was wrong** — verified ground truth on shrouded-toucan:

- **Writers**: `src/services/sqlite/transactions.ts:133-143` (the successful-ack path) and `src/services/sqlite/SessionStore.ts:2239`.
- **Reader**: `src/services/sqlite/PendingMessageStore.ts:326-342` (`getRecentlyProcessed`).
- **UI consumer**: `src/services/worker/http/routes/DataRoutes.ts:434` (feeds a "recently processed" panel in the viewer).
- **Schema**: CHECK constraint `status IN ('pending','processing','processed','failed')` at `SessionStore.ts:566`, `migrations/runner.ts:536, :1108`. Type union at `PendingMessageStore.ts:22`.

To reach the audit's target design ("done = delete row"), we must:
1. **Change ack from UPDATE → DELETE** at the two writer sites.
2. **Delete `getRecentlyProcessed`** and its UI caller — the "recently processed" viewer panel disappears. If the panel is deemed must-keep, replace its data source with observations inserted in the last N minutes (observations.created_at_epoch index) — that's the actual thing users cared about anyway.
3. **Drop `'processed'`** from the CHECK constraint + enum via a new migration.

This is still ~60 LOC net (the plan's estimate) because we're replacing UPDATE statements with DELETE statements of similar length; the migration adds ~15 LOC; the UI removal deletes ~10 LOC.

### 3B. Ack path: UPDATE → DELETE

**Edit `src/services/sqlite/transactions.ts:133-143`** — replace the UPDATE block:

```typescript
// OLD:
// UPDATE pending_messages SET status='processed', completed_at_epoch=?, tool_input=NULL, tool_response=NULL WHERE id=? AND status='processing'

// NEW — done = delete row (audit target design):
const deleteStmt = db.prepare(`
  DELETE FROM pending_messages
  WHERE id = ? AND status = 'processing'
`);
```

Drop the `completed_at_epoch = ?` argument from the call. The row is gone; nothing needs to record when it was processed.

**Edit `src/services/sqlite/SessionStore.ts:2239`** — same treatment. Find the enclosing SQL statement and convert from UPDATE-to-processed to DELETE. Verify the callsite is actually the successful-ack path (not some other "processed" write); if it's unrelated dead code, just delete it outright.

### 3C. Delete the reader + UI consumer

**Edit `src/services/sqlite/PendingMessageStore.ts:326-342`** — delete the entire `getRecentlyProcessed` method (incl. JSDoc).

**Edit `src/services/worker/http/routes/DataRoutes.ts:434`** — find the enclosing endpoint (likely `/api/recent-processed` or similar).

Decision tree:
- **If the endpoint is used only for a "recent activity" viewer panel**: delete the endpoint. Viewers show recent observations via `observations.created_at_epoch DESC` already; the processed-messages panel was redundant telemetry.
- **If the panel is considered a must-keep feature**: change the query to pull recent observations instead:
  ```typescript
  const recent = db.prepare(`
    SELECT o.*, ss.project
    FROM observations o
    LEFT JOIN sdk_sessions ss ON o.session_db_id = ss.id
    WHERE o.created_at_epoch > ?
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(Date.now() - 30 * 60 * 1000, 20);
  ```

Recommendation: **delete it**. The viewer already has a better signal.

Update any React/UI calls that hit this endpoint — grep the viewer bundle for the route name.

### 3D. Drop `'processed'` from schema

**Create `src/services/sqlite/migrations/M-drop-processed-status.ts`** (numbered one past the current max):

```typescript
export function up(db: Database): void {
  db.exec(`
    -- SQLite doesn't support ALTER TABLE for CHECK constraints.
    -- Recreate the table with the new constraint.
    CREATE TABLE pending_messages_new (
      -- copy the current pending_messages schema here VERBATIM from
      -- SessionStore.ts:540-580, except change:
      --   status TEXT NOT NULL DEFAULT 'pending'
      --     CHECK(status IN ('pending', 'processing', 'failed'))
      -- (removed 'processed')
    );
    INSERT INTO pending_messages_new SELECT * FROM pending_messages
      WHERE status != 'processed';
    DROP TABLE pending_messages;
    ALTER TABLE pending_messages_new RENAME TO pending_messages;
    -- Recreate indexes (copy from current schema).
  `);
}
```

Add the migration to the `MigrationRunner` registration (wherever migrations are listed).

Update **type unions** to remove `'processed'`:
- `src/services/sqlite/PendingMessageStore.ts:22` — `status: 'pending' | 'processing' | 'failed'`.
- Any other `'processed'` string literal matches `rg "'processed'" src/` should flag (exclude the migration file itself).

Update `SessionStore.ts:566` + `migrations/runner.ts:536, :1108` CHECK constraints — they're the CREATE TABLE statements for new DBs, not drop-legacy. Remove `'processed'` from the tuple.

### 3E. Collapse 4 reset methods → 1 `recoverStaleProcessing`

**Edit `src/services/sqlite/PendingMessageStore.ts`** — replace the 4 methods at `:166, :256, :316, :381` with a single:

```typescript
/**
 * Recover stale processing messages: UPDATE processing → pending for rows
 * whose started_processing_at_epoch is older than threshold.
 *
 * Called on worker startup (threshold = 0, reset all) and periodically
 * (threshold = 60_000, only rows stuck >60s).
 */
recoverStaleProcessing(thresholdMs: number = 60_000, sessionDbId?: number): number {
  const cutoff = thresholdMs === 0 ? Date.now() + 1 : Date.now() - thresholdMs;
  const sql = sessionDbId !== undefined
    ? `UPDATE pending_messages
       SET status = 'pending', started_processing_at_epoch = NULL
       WHERE status = 'processing'
         AND session_db_id = ?
         AND started_processing_at_epoch < ?`
    : `UPDATE pending_messages
       SET status = 'pending', started_processing_at_epoch = NULL
       WHERE status = 'processing'
         AND started_processing_at_epoch < ?`;

  const stmt = this.db.prepare(sql);
  const result = sessionDbId !== undefined
    ? stmt.run(sessionDbId, cutoff)
    : stmt.run(cutoff);
  return result.changes;
}
```

Update call sites:
- `worker-service.ts:423` (`resetStaleProcessingMessages(0)`) → `recoverStaleProcessing(0)`.
- Any other callers of the 4 old methods — grep:
  ```
  rg "resetStaleProcessingMessages|resetProcessingToPending|retryAllStuck|resetStuckMessages" src/
  ```
  Expected post-edit: zero matches.

### 3F. Collapse 4 count methods → 1 `getQueueStatus`

**Edit `src/services/worker/SessionManager.ts:585-625`** — replace the 4 methods with:

```typescript
getQueueStatus(): { pending: number; processing: number; total: number; hasWork: boolean } {
  // Implementation: aggregate across per-session counts.
  // Look at the current getTotalQueueDepth implementation at :599
  // for the aggregation logic.
  // ...
  return { pending, processing, total: pending + processing, hasWork: pending + processing > 0 };
}
```

Update call sites:
- `worker-service.ts:1094` (`getTotalActiveWork()`) → `getQueueStatus().total`.
- `ViewerRoutes.ts:101-102` (`isAnySessionProcessing()` + `getTotalActiveWork()`) → single `const { total, hasWork } = …getQueueStatus();`.
- `DataRoutes.ts:306-307, :319-320` — same pattern.

### 3G. Delete `markSessionMessagesFailed`

**Edit `src/services/sqlite/PendingMessageStore.ts:271-285`** — delete the method. Grep to confirm no callers:
```
rg "markSessionMessagesFailed" src/
```
Expected: zero matches. (Phase 1 removed its only caller via the `terminateSession` refactor.)

### 3H. Verification
1. `npm run build` clean.
2. `npx tsc --noEmit` clean.
3. `npm test` — queue lifecycle tests, retry tests, ack/nack tests. Expect test updates: any assertion that `status === 'processed'` after ack must change to `row does not exist` after ack.
4. Migration test: on a restored copy of production DB (snapshot `.docker-claude-mem-data/` to `.docker-claude-mem-data-backup/` first), run the worker and confirm the migration completes without errors. Expected:
   ```bash
   docker exec claude-mem-dev sqlite3 ~/.claude-mem/claude-mem.db \
     "SELECT sql FROM sqlite_master WHERE name='pending_messages'"
   ```
   Output should NOT contain `'processed'` in the CHECK constraint.
5. Insert a stuck `processing` row manually:
   ```bash
   docker exec claude-mem-dev sqlite3 ~/.claude-mem/claude-mem.db \
     "INSERT INTO pending_messages (session_db_id, status, started_processing_at_epoch) VALUES (1, 'processing', 1000)"
   ```
   Restart worker; confirm `recoverStaleProcessing(0)` flipped it back to `pending`.
6. Smoke: drive a full session end-to-end. Confirm observations persist, queue depth returns to 0 after completion, no rows left in `processing` or an imaginary `'processed'` state.
7. Grep confirmation:
   ```
   rg "'processed'" src/       # should return only migration-related matches
   rg "markSessionMessagesFailed|resetStale|resetProcessingToPending|retryAllStuck|resetStuckMessages|hasPendingMessages|getTotalQueueDepth|getTotalActiveWork|isAnySessionProcessing|getRecentlyProcessed" src/   # should be empty
   ```

### 3I. Commit

```
refactor: simplify queue state machine (cleanup phase 3)

- Ack path: UPDATE status='processed' → DELETE row. Done = gone.
- Drop 'processed' from pending_messages CHECK constraint via migration.
- Delete getRecentlyProcessed + its DataRoutes endpoint.
- Collapse 4 reset* methods → recoverStaleProcessing(thresholdMs).
- Collapse 4 count* methods in SessionManager → getQueueStatus().
- Delete markSessionMessagesFailed (unused after phase 1).

Queue now has 2 statuses (pending, processing) instead of 4. Retry is
implicit via retry_count; exhausted retries are deleted silently.
```

### 3J. Anti-pattern guards (Phase 3)
- Do NOT introduce a new "done" terminal state. Delete the row.
- Do NOT keep any collapsed method as a thin alias "for backward compat." Delete them.
- Do NOT skip the migration. A stale CHECK constraint silently accepts new `'processed'` writes even after you think the state is gone.
- Do NOT keep `getRecentlyProcessed` stubbed "in case the UI wants it back." Remove it.

---

## Phase 4 — Delete FTS5 subsystem (~200 LOC)

**Goal**: remove the 6 triggers that fire on every observation/summary/prompt INSERT + 3 virtual tables. Chroma already owns search (`SessionSearch.ts:21-22, 40-56` explicitly comments this).

### 4A. Pre-scan
```
rg "observations_fts|session_summaries_fts|user_prompts_fts|CREATE VIRTUAL TABLE.*fts5|CREATE TRIGGER.*(observations|session_summaries|user_prompts)_(ai|ad|au)\b" src/
```
Expected matches (from audit): `SessionSearch.ts`, `SessionStore.ts`, `migrations.ts`, `migrations/runner.ts`. Anything else is a surprise — investigate before proceeding.

### 4B. Create drop migration

**Create `src/services/sqlite/migrations/M-drop-fts5.ts`** (numbered past the Phase 3 migration):

```typescript
export function up(db: Database): void {
  db.exec(`
    -- Drop 6 triggers (2 per FTS table × 3 tables) + 3 virtual tables.
    DROP TRIGGER IF EXISTS observations_ai;
    DROP TRIGGER IF EXISTS observations_ad;
    DROP TRIGGER IF EXISTS observations_au;
    DROP TRIGGER IF EXISTS session_summaries_ai;
    DROP TRIGGER IF EXISTS session_summaries_ad;
    DROP TRIGGER IF EXISTS session_summaries_au;
    DROP TRIGGER IF EXISTS user_prompts_ai;
    DROP TRIGGER IF EXISTS user_prompts_ad;
    DROP TRIGGER IF EXISTS user_prompts_au;
    DROP TABLE IF EXISTS observations_fts;
    DROP TABLE IF EXISTS session_summaries_fts;
    DROP TABLE IF EXISTS user_prompts_fts;
  `);
}
```

Register in `MigrationRunner`.

### 4C. Delete FTS creation paths

**Edit `src/services/sqlite/SessionSearch.ts`**:
- Delete `:61` (hasFTS detection line).
- Delete `:92` (`CREATE VIRTUAL TABLE _fts5_probe` availability probe — obsolete once we don't use FTS).
- Delete `:106-145` (observations_fts virtual table + 3 triggers).
- Delete `:147-185` (session_summaries_fts virtual table + 3 triggers).
- Update `buildOrderClause` at `:290` — remove the `hasFTS` / `ftsTable` parameters and the FTS ordering branch; keep only non-FTS ordering. Grep for callers to update signatures.
- Update the file header comment at `:21-22, 40-56` — remove the "backward compatibility" stale note; replace with a one-liner: "Search uses Chroma; SessionSearch handles filter-only SQLite queries."

**Edit `src/services/sqlite/SessionStore.ts`**:
- Delete `:452-486` (user_prompts_fts creation + 3 triggers).
- Delete `:748-765` (observations triggers — duplicate of SessionSearch paths).
- Delete `:811-826` (session_summaries triggers).
- Delete `:855, :869` (hasFTS guard branches) — after deletion the calling function simplifies.
- Delete `:2819-2830` (`rebuildFtsIndex` or similar method — obsolete).

**Edit `src/services/sqlite/migrations.ts`**:
- Delete `:379-478` (the v5 FTS migration body). Keep only the `DROP TABLE IF EXISTS …_fts` lines at `:478-483` AS THE NEW CONTENT of that migration — i.e., mark the migration as "already-dropped" for legacy DBs. Or, alternatively, delete the migration entry entirely and rely on the new Phase 4 drop migration to handle all cases.

  Recommendation: **delete the v5 FTS migration** entirely, then ensure the new `M-drop-fts5` migration is idempotent (uses `IF EXISTS`). Legacy DBs get the DROPs via the new migration; fresh DBs never have the FTS tables in the first place.

**Edit `src/services/sqlite/migrations/runner.ts`**:
- Delete `:427` (FTS warn log).
- Delete `:445-465+` (user_prompts_fts creation + triggers inside runner).
- Audit for any other FTS leftovers.

### 4D. Verification
1. `npm run build` clean.
2. `npx tsc --noEmit` clean. Type errors likely in `SessionSearch` callers once `hasFTS` param is dropped — fix them.
3. `npm test` — search tests. Any FTS-specific test → delete. Any test that hits the MCP `search` tool via Chroma → unchanged.
4. **Fresh-DB boot**: delete `.docker-claude-mem-data/`, start worker, confirm no FTS artifacts:
   ```bash
   docker exec claude-mem-dev sqlite3 ~/.claude-mem/claude-mem.db \
     ".schema" | grep -iE "fts|observations_a[iud]|session_summaries_a[iud]|user_prompts_a[iud]"
   ```
   Expected: **empty output**.
5. **Existing-DB boot** on a snapshot of production:
   ```bash
   cp -r .docker-claude-mem-data .docker-claude-mem-data-phase4-backup
   ```
   Start worker on the live copy. Confirm migration completes, same schema check → empty.
6. Drive a full session. Observations insert → confirm no trigger overhead (sqlite timing), observations searchable via MCP `search` tool (Chroma).
7. Rollback plan: if anything breaks, `rm -rf .docker-claude-mem-data && mv .docker-claude-mem-data-phase4-backup .docker-claude-mem-data` and revert the commit.

### 4E. Commit

```
chore: delete dead FTS5 subsystem (cleanup phase 4)

- Drop 6 FTS5 triggers + 3 virtual tables via new migration.
- Delete 200+ LOC of FTS5 creation code in SessionStore/SessionSearch/migrations.
- Remove hasFTS branches from buildOrderClause and friends.

Chroma has been the sole search path since v11 (comment at SessionSearch:21-22).
Every observation INSERT was firing 2 FTS triggers for zero benefit; this
reclaims that cost.
```

### 4F. Anti-pattern guards (Phase 4)
- Do NOT leave "empty placeholder" FTS tables.
- Do NOT ship without running against a snapshot of production data. FTS-bound migrations can brick real users.
- Do NOT keep the `_fts5_probe` availability check — once we don't use FTS, the probe is a waste.

---

## Phase 5 — Collapse context generation (~900 LOC net deletion)

**Goal**: `ContextBuilder → ObservationCompiler → TokenCalculator → (AgentFormatter | HumanFormatter) → (Header|Summary|Timeline|Footer)Renderer` (9 files, 1,624 LOC) collapses to one `generateContext(observations, summaries, config, forHuman): string` at ~200 LOC in a single file.

### 5A. Pre-read — map callers + entry points

Before touching code, run:
```bash
rg -n "from ['\"].*services/context['\"]" src/
rg -n "ContextBuilder|ObservationCompiler|AgentFormatter|HumanFormatter|HeaderRenderer|SummaryRenderer|TimelineRenderer|FooterRenderer" src/
```
Expected callers (verified): `src/services/context-generator.ts`, `src/services/worker/FormattingService.ts`, `src/services/worker/http/routes/SearchRoutes.ts`, `src/shared/timeline-formatting.ts`, `src/services/sqlite/SessionStore.ts` (likely doc comment only).

Map each caller's actual entry point (`new ContextBuilder(…).build(…)` / `.generate()` / similar) — that's the signature `generateContext` must replicate.

### 5B. Write the new function

**Create `src/services/context/generateContext.ts`** (~200 LOC target):

```typescript
import { Observation, SessionSummary, ContextConfig } from './types.js';
// Salvage: buildTimeline + calculateTokenEconomics become local helpers here.

export function generateContext(
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  forHuman: boolean
): string {
  // Inline: compile observations (from ObservationCompiler), calculate tokens,
  // render header, render summaries, render timeline, render footer.
  // Two small branches: forHuman uses HumanFormatter's markdown; !forHuman uses
  // AgentFormatter's more compact form.
  //
  // No classes. Just functions + string concat.
  return parts.join('\n\n');
}
```

Copy the rendering logic from the 9 existing files inline. Keep the `buildTimeline` helper + `calculateTokenEconomics` as local functions — they encapsulate real logic.

### 5C. Migrate callers

Update each caller (list from 5A) to import `generateContext` and call it directly. Delete the wrapper shims if any.

### 5D. Delete the old pipeline

After all callers migrated:
```bash
rm -r src/services/context/formatters src/services/context/sections
rm src/services/context/ContextBuilder.ts
rm src/services/context/ContextConfigLoader.ts
rm src/services/context/ObservationCompiler.ts
rm src/services/context/TokenCalculator.ts
rm src/services/context/index.ts
# Keep types.ts IF generateContext.ts still imports from it. Otherwise delete.
```

Replace `src/services/context/index.ts` with a one-line re-export:
```typescript
export { generateContext } from './generateContext.js';
```

### 5E. Verification
1. `npm run build` clean.
2. `npx tsc --noEmit` clean.
3. **Snapshot test** — the critical gate:
   - Before starting Phase 5: capture the output of the old pipeline for 5 representative sessions (different observation counts, token budgets, agent+human modes). Dump each to `/tmp/context-snapshot-$i.txt`.
   - After the refactor: re-run the same inputs through `generateContext`. Diff each:
     ```bash
     diff -u /tmp/context-snapshot-agent-1.txt /tmp/context-new-agent-1.txt
     ```
   - **Zero whitespace-normalized diff**. Any difference → investigate. Acceptable exceptions: trailing-newline variance (strip with `sed`).
4. `npm test` — context-generation tests. Expect test updates since 9 classes are gone; assertions move to function outputs.
5. Viewer smoke: open `http://localhost:37778/`, render a session summary in both agent and human modes, confirm identical visual output to pre-refactor screenshots.
6. Grep confirmation:
   ```
   rg "ContextBuilder|ObservationCompiler|TokenCalculator|AgentFormatter|HumanFormatter|HeaderRenderer|SummaryRenderer|TimelineRenderer|FooterRenderer" src/
   ```
   Expected: zero matches outside `generateContext.ts` internal comments.

### 5F. Commit

```
refactor: collapse context generation pipeline (cleanup phase 5)

- 9 classes (ContextBuilder, ObservationCompiler, TokenCalculator,
  Agent/HumanFormatter, 4 Renderers) → single generateContext() function.
- 1,624 LOC → ~200 LOC. Same output; snapshot-verified across 5 sessions.
- types.ts kept for shared interfaces; index.ts becomes a re-export.

Salvaged: buildTimeline + calculateTokenEconomics as local helpers.
```

### 5G. Anti-pattern guards (Phase 5)
- Do NOT introduce any new classes. One function, plain string building.
- Do NOT "migrate gradually" behind a feature flag. Cutover in the same commit.
- Do NOT split `generateContext` into 5 sub-functions that just re-invent the renderer pattern. Inline the work.

---

## Final verification (after Phase 5 commits)

### LOC delta
```bash
git diff --stat main...HEAD -- src/ | tail -1
```
Target: net deletion between **1,200 and 1,500 LOC** (audit estimate: ~1,340). Outside that range → re-audit what drifted.

### Insert-path performance
Before Phase 4:
```bash
docker exec claude-mem-dev bash -c 'time sqlite3 ~/.claude-mem/claude-mem.db \
  "INSERT INTO observations (session_db_id, type, title) VALUES (1, \"test\", \"test\");
  " <<EOF
$(for i in {1..1000}; do echo "INSERT INTO observations (session_db_id, type, title) VALUES (1, \"test$i\", \"title$i\");"; done)
EOF'
```
After Phase 4: same benchmark. Expect **measurably faster** insert throughput (6 fewer triggers per row).

### Full suite
- `npm test` — zero regressions.
- `npm run build-and-sync` — clean marketplace push.
- Dev container smoke: a full session end-to-end (session init → observations stream → summary → session end) runs without error. Viewer renders correctly.

### Update the audit doc
Open `ARCHITECTURE-AUDIT-2026-04-19.md`, flip Phases 1–5 rows at `:124-138` to `✅ Done`. Add a post-mortem at `:283` noting:
- What the audit predicted vs what shipped.
- The Phase 3 amendment (the `'processed'` state was not dead — had to flip ack semantics).
- Any surprises encountered during snapshot verification in Phase 5.

### PR description template
```
## Summary
Implements Phases 1–5 of ARCHITECTURE-AUDIT-2026-04-19.md. Net ~1,340 LOC
deletion, zero feature regressions.

- Phase 1: Delete drain + parser strict + Chroma null-guards (fixes luma incident)
- Phase 2: Unify buildPrompt + selectActiveAgent
- Phase 3: Queue state machine → 2 statuses; done = DELETE row
- Phase 4: Delete FTS5 (6 triggers × every insert → 0)
- Phase 5: Collapse 9-class context pipeline → one function

## Verification
- [x] Phase 1 luma-container SIGTERM test: rows stay pending
- [x] Phase 1 Chroma null-path: returns structured error, no crash
- [x] Phase 1 parser strictness: ghost observations rejected
- [x] Phase 3 migration: dropped 'processed' from CHECK constraint on production snapshot
- [x] Phase 4 fresh-DB + snapshot-DB boot: no FTS artifacts
- [x] Phase 5 snapshot diff: 5 sessions, zero whitespace-normalized diff
- [x] LOC delta: -1,312 (within audit's ±10% envelope)
- [x] Full test suite passes
- [x] Marketplace build-and-sync clean

## Out of scope
Phases 6–13 (BaseAgent extraction, migration consolidation, legacy endpoint
removal, 2-hop hook chain, etc.) — see CLEANUP-EXECUTION-PLAN-2026-04-19.md.
```

---

## Out of scope — explicitly deferred (audit Phases 6–13)

These are **not** in this PR. Each merits its own PR with its own plan:

| # | Phase | Why deferred |
|---|---|---|
| 6 | Delete `runFallbackForTerminatedSession` fallback chain | Medium risk — behavioral change in failure recovery. Gate behind settings flag first. |
| 7 | Extract `BaseAgent` + thin adapters for 3 providers | Medium risk — touches all 3 agents. 3 days effort. Natural followup after Phase 2 settles. |
| 8 | Delete legacy `/sessions/:sessionDbId/*` endpoint shape | Needs audit of external callers first (OpenCode? CLI? any integration test?). |
| 9 | Consolidate 3 migration systems → 1 `MigrationRunner` | ~1,200 LOC change, careful ordering. High blast radius on fresh installs. |
| 10 | Merge per-method storage files → 4 `operations.ts` | Pure refactor, low risk. Easy followup when someone has a Friday. |
| 11 | Drop legacy v1 tables + dead columns (`relevance_count`, `generated_by_model`, etc.) | Schema cleanup; needs archival decision + communication. |
| 12 | Extract `SessionLifecycleManager` | 1 week effort, higher risk — touches core lifecycle. Wait for Phases 1–5 to settle. |
| 13 | Flatten 4-hop hook chain → 2-hop | 1 week effort, touches every IDE adapter. Coordinate with claude-code / cursor / gemini-cli teams. |

**Rationale**: Phases 1–5 are the fast path — they fix the incident, kill the biggest insert-time tax (FTS), and collapse the most egregious over-abstraction (context pipeline). Each later phase benefits from the ground Phases 1–5 clear, but none are on the incident's critical path.

---

## Commit cadence recap

| Phase | Commit message | Effort | Risk |
|---|---|---|---|
| 1 | `fix: stop draining pending messages on session death (cleanup phase 1)` | 1 hr | Low — **fixes incident** |
| 2 | `refactor: unify prompt builder and agent selector (cleanup phase 2)` | 2 hrs | Low |
| 3 | `refactor: simplify queue state machine (cleanup phase 3)` | 4 hrs (+ migration) | Low-Med (schema migration) |
| 4 | `chore: delete dead FTS5 subsystem (cleanup phase 4)` | 4 hrs (+ migration) | Low (Chroma owns search) |
| 5 | `refactor: collapse context generation pipeline (cleanup phase 5)` | 1 day | Low (snapshot-verified) |

Total effort estimate: **~2.5 days of focused work**.

Build-and-sync cadence: only after each phase passes its own verification gate. Phase 1 has a mandatory dev-container smoke test before any marketplace sync.

---

## Files created / modified / deleted (summary)

**Created**:
- `src/services/worker/AgentSelector.ts` (Phase 2, ~40 LOC)
- `src/services/sqlite/migrations/M-drop-processed-status.ts` (Phase 3)
- `src/services/sqlite/migrations/M-drop-fts5.ts` (Phase 4)
- `src/services/context/generateContext.ts` (Phase 5, ~200 LOC)
- This file: `CLEANUP-EXECUTION-PLAN-2026-04-19.md`

**Modified**:
- `src/services/worker/session/SessionCompletionHandler.ts` (Phase 1)
- `src/services/worker-service.ts` (Phase 1, 2, 3)
- `src/services/worker/http/routes/SessionRoutes.ts` (Phase 1, 2)
- `src/services/worker/http/routes/DataRoutes.ts` (Phase 3)
- `src/services/worker/http/routes/ViewerRoutes.ts` (Phase 3)
- `src/services/sqlite/PendingMessageStore.ts` (Phase 1, 3)
- `src/services/sqlite/transactions.ts` (Phase 3)
- `src/services/sqlite/SessionStore.ts` (Phase 3, 4)
- `src/services/sqlite/SessionSearch.ts` (Phase 4)
- `src/services/sqlite/migrations.ts` (Phase 4)
- `src/services/sqlite/migrations/runner.ts` (Phase 3, 4)
- `src/sdk/parser.ts` (Phase 1)
- `src/sdk/prompts.ts` (Phase 2)
- `src/services/worker/SDKAgent.ts` (Phase 2)
- `src/services/worker/GeminiAgent.ts` (Phase 2)
- `src/services/worker/OpenRouterAgent.ts` (Phase 2)
- `src/services/worker/SearchManager.ts` (Phase 1)
- `src/services/worker/SessionManager.ts` (Phase 3)
- `src/services/context/index.ts` (Phase 5 — becomes re-export)
- `src/services/context-generator.ts`, `src/services/worker/FormattingService.ts`, `src/services/worker/http/routes/SearchRoutes.ts`, `src/shared/timeline-formatting.ts` (Phase 5 — import updates)
- `tests/zombie-prevention.test.ts` (Phase 1)
- `tests/worker/session-lifecycle-guard.test.ts` (Phase 1)
- `docs/architecture-overview.md` (Phase 1)
- `ARCHITECTURE-AUDIT-2026-04-19.md` (post-phase doc-flip)

**Deleted**:
- `src/services/context/ContextBuilder.ts` (Phase 5)
- `src/services/context/ContextConfigLoader.ts` (Phase 5)
- `src/services/context/ObservationCompiler.ts` (Phase 5)
- `src/services/context/TokenCalculator.ts` (Phase 5)
- `src/services/context/types.ts` (Phase 5, if unused — else kept)
- `src/services/context/formatters/AgentFormatter.ts` (Phase 5)
- `src/services/context/formatters/HumanFormatter.ts` (Phase 5)
- `src/services/context/sections/FooterRenderer.ts` (Phase 5)
- `src/services/context/sections/HeaderRenderer.ts` (Phase 5)
- `src/services/context/sections/SummaryRenderer.ts` (Phase 5)
- `src/services/context/sections/TimelineRenderer.ts` (Phase 5)
- `src/services/context/formatters/` (Phase 5 — directory)
- `src/services/context/sections/` (Phase 5 — directory)

---

*End of plan. Begin with Phase 1. Do not skip phases. Do not batch commits. The order exists because the incident fix (Phase 1) is the prerequisite for trust in the rest.*

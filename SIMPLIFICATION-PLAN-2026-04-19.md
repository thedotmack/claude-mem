# Claude-Mem Simplification Plan — 2026-04-19

Companion to `ARCHITECTURE-AUDIT-2026-04-19.md`. Each phase is an independent commit. Smoke-test Phase 1 in the luma container **before** any `npm run build-and-sync` to the marketplace. Subsequent phases can build-and-sync once their verification step passes.

---

## Phase 0 — Ground truth (pre-verified)

All file paths and line numbers below were confirmed via grep against the current working tree (branch `thedotmack/merged-layer3-metadata`).

### Call sites for `markAllSessionMessagesAbandoned`
- `src/services/worker/session/SessionCompletionHandler.ts:44` (inside the `try { … }` block spanning **lines 35–54**).
- `src/services/worker-service.ts:911` (inside the "no fallback available" branch after the OpenRouter attempt at `:895`).
- `src/services/worker-service.ts:934` (inside `terminateSession(sessionDbId, reason)` at `:932`).
- `src/services/worker/http/routes/SessionRoutes.ts:123` (inside the wall-clock-age guard at `:112`, block **lines 122–124**).
- **Definition** to remove: `src/services/sqlite/PendingMessageStore.ts:287-302`.
- **Docs** that reference the method (must be updated): `docs/architecture-overview.md:81`.
- **Tests** that assert the method's behavior (must be deleted/rewritten, not just unblocked): `tests/zombie-prevention.test.ts:346, 361, 373, 377, 413, 414, 415, 429, 453, 473` and `tests/worker/session-lifecycle-guard.test.ts:158`.

### Parser target lines
- `src/sdk/parser.ts:33-111` — `parseObservations`.
- Fallback-to-mode-first-type lives at `:56-69` (`fallbackType` + the `if/else` that logs and continues on invalid/missing type).
- Empty-observation guard already exists at `:85-96` — we are tightening it, not replacing it.
- `coerceObservationToSummary` lives at `:222-259`, already logs a warn at `:244`. Decision: leave as-is for Phase 1; flag for Phase 2 with a comment.

### SearchManager target lines
- `findByConcept` starts at `:1099`. Destructures `{ concepts: concept, ... }` at `:1101`. First passes to Chroma at `:1115` (via `this.queryChroma(concept, …)`).
- `findByFile` starts at `:1167`. Destructures `{ files: rawFilePath, ... }` at `:1169`. Normalizes `rawFilePath` at `:1171`. First passes to Chroma at `:1190`.
- `findByType` starts ~`:1288`. Destructures `{ type, ... }` at `:1291`. Normalizes `typeStr` at `:1292`. First passes to Chroma at `:1306`.

### Build + smoke-test commands (from CLAUDE.md)
```bash
npm run build                                   # regenerates plugin/ (bind-mounted into luma container)
docker exec claude-mem-luma bash -c \
  'pkill -f worker-service.cjs; \
   exec bun /opt/claude-mem/scripts/worker-service.cjs \
        >> ~/.claude-mem/logs/worker.log 2>&1 &'
# Then drive observations from claude-mem-luma and watch the log.
```

**Do NOT** run `npm run build-and-sync` until Phase 1 passes smoke test.

---

## Phase 1 — Incident fix (the three deletions)

**Goal**: stop flipping pending rows to `failed` when a session dies. Stop emitting observations with mode-fallback types when the SDK omits `<type>`. Stop passing `undefined` to Chroma. One commit.

### 1A. Delete the drain

**Edit `src/services/worker/session/SessionCompletionHandler.ts`**
Remove lines **35–54** (the entire `// Drain orphaned pending messages …` comment block through the end of the outer `try { … } catch { … }`). Replace with nothing. After the edit the method body is:
```typescript
async completeByDbId(sessionDbId: number): Promise<void> {
  this.dbManager.getSessionStore().markSessionCompleted(sessionDbId);
  await this.sessionManager.deleteSession(sessionDbId);
  this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
}
```

**Edit `src/services/worker-service.ts`**
- At `:909-917` (the block starting `// No fallback or both failed…`): delete the two `pendingStore` + `abandoned` lines and the `if (abandoned > 0) { logger.warn… }` block. Keep `removeSessionImmediate` and `broadcastSessionCompleted`. After the edit the block is just:
  ```typescript
  // No fallback or both failed: leave pending messages for future recovery
  this.sessionManager.removeSessionImmediate(sessionDbId);
  this.sessionEventBroadcaster.broadcastSessionCompleted(sessionDbId);
  ```
- At `:932-944` (`terminateSession`): delete the `pendingStore` + `abandoned` lines. The `logger.info('SYSTEM', 'Session terminated', …)` call stays but drops the `abandonedMessages` field. Method becomes:
  ```typescript
  private terminateSession(sessionDbId: number, reason: string): void {
    logger.info('SYSTEM', 'Session terminated', { sessionId: sessionDbId, reason });
    this.sessionManager.removeSessionImmediate(sessionDbId);
  }
  ```

**Edit `src/services/worker/http/routes/SessionRoutes.ts`**
- At `:122-124` (inside the wall-clock-age guard): delete the two `pendingStore` + `markAllSessionMessagesAbandoned` lines. Keep `abortController.abort()` at `:120` and `removeSessionImmediate(sessionDbId)` at `:124` (now renumbered). The guard aborts the session; pending rows stay pending.

**Edit `src/services/sqlite/PendingMessageStore.ts`**
- Delete the entire `markAllSessionMessagesAbandoned` method (lines **287–302**, including the JSDoc block).

**Optional (enable cleanup without resurrecting the drain):** in `src/services/sqlite/SessionStore.ts` at the top of `markSessionCompleted` (currently `:1095`), add:
```typescript
this.db.prepare('DELETE FROM pending_messages WHERE session_db_id = ?').run(sessionDbId);
```
Do this only if deleting-on-complete is desired now. Otherwise leave the rows; a later FK-cascade phase will handle it. The audit's "philosophy" is *pending is fine* — don't flip to `failed`.

### 1B. Parser strictness

**Edit `src/sdk/parser.ts`** in `parseObservations` (currently `:33-111`):

- Replace the `fallbackType` / `finalType` block (current `:56-69`) with a strict reject:
  ```typescript
  const mode = ModeManager.getInstance().getActiveMode();
  const validTypes = mode.observation_types.map(t => t.id);

  if (!type || type.trim() === '') {
    logger.error('PARSER', 'Observation has no type — rejecting', { correlationId });
    continue;
  }
  if (!validTypes.includes(type.trim())) {
    logger.error('PARSER', `Invalid observation type "${type}" — rejecting`, { correlationId, validTypes });
    continue;
  }
  const finalType = type.trim();
  ```
  This removes the `fallbackType` fallback entirely. Downstream code that used `finalType` is untouched.

- After the `while` loop closes (current `:108`), before `return observations;` at `:110`, add:
  ```typescript
  if (observations.length === 0 && text.trim().length > 100) {
    logger.warn(
      'PARSER',
      'Large response produced zero observations — possible SDK format drift',
      { correlationId, rawSnippet: text.slice(0, 500) }
    );
  }
  ```

- **Do not** modify `coerceObservationToSummary` in Phase 1. The audit flags it as a band-aid for `parseSummary`, not `parseObservations`, so it's out of scope here. Add a `// TODO(simplify-phase-2): log whenever this fires, then delete in phase 3` comment above the function declaration at `:222` so the trail is visible.

### 1C. Chroma null guards

**Edit `src/services/worker/SearchManager.ts`**, adding one guard at the top of each of the three methods (immediately after the destructure, before any `await this.queryChroma(...)` call).

- `findByConcept` — after `:1101`:
  ```typescript
  if (!concept || (typeof concept === 'string' && concept.trim() === '')) {
    return { content: [{ type: 'text' as const, text: 'Concept is required' }] };
  }
  ```
- `findByFile` — after the `filePath` normalize at `:1171`:
  ```typescript
  if (!filePath || (typeof filePath === 'string' && filePath.trim() === '')) {
    return { content: [{ type: 'text' as const, text: 'File path is required' }] };
  }
  ```
- `findByType` — after `:1292`:
  ```typescript
  if (!type || (typeof type === 'string' && type.trim() === '') || (Array.isArray(type) && type.length === 0)) {
    return { content: [{ type: 'text' as const, text: 'Type is required' }] };
  }
  ```

### 1D. Tests + docs

- `tests/zombie-prevention.test.ts`: every assertion on `markAllSessionMessagesAbandoned(...)` either (a) deletes the test, or (b) swaps to asserting that pending rows remain `pending` after session completion (matching the new behavior). Prefer deletion for tests whose *purpose* was asserting the drain; the "zombie prevention" intent is now expressed by the retry loop leaving rows alone.
- `tests/worker/session-lifecycle-guard.test.ts:158`: update the comment + assertion — simulation should verify rows are **not** marked failed.
- `docs/architecture-overview.md:81`: remove or update the `markAllSessionMessagesAbandoned(sessionDbId)` reference in the lifecycle diagram to show rows remaining `pending`.

### 1E. Verification (do this IN ORDER — don't build-and-sync until all pass)

1. `npm run build` (host) — should compile cleanly. TypeScript errors here are blocking.
2. `npx tsc --noEmit` (host) — confirm no type regressions from removed method.
3. `npm test -- tests/zombie-prevention.test.ts tests/worker/session-lifecycle-guard.test.ts` — passes with the updated/deleted tests.
4. Restart worker in luma container using the command in Phase 0.
5. **Trigger a SIGTERM scenario**: drive observations into the container, then `docker exec claude-mem-luma bash -c 'pkill -TERM -f "claude.*--print"'` (or wait for the 17-min natural timeout). Confirm via SQLite:
   ```bash
   docker exec claude-mem-luma sqlite3 ~/.claude-mem/claude-mem.db \
     "SELECT status, COUNT(*) FROM pending_messages GROUP BY status"
   ```
   Expect: rows stay in `pending` / `processing`, NOT `failed`. After worker restart → stale `processing` rows reset to `pending` and get picked up.
6. **Trigger Chroma null-path**: `curl -sS 'http://localhost:37779/api/mcp/find_by_file'` (no args). Expect: `{"content":[{"type":"text","text":"File path is required"}]}`, HTTP 200. Do NOT expect a Pydantic traceback in `worker.log`.
7. **Trigger parser strictness**: send a test observation with `<observation></observation>` or no `<type>`. Expect `logger.error('PARSER', 'Observation has no type — rejecting', …)` in the log; zero observations stored; no mode-fallback-type observations appearing in the viewer.
8. **Only after all 7 pass**: commit with message `fix: stop draining pending messages on session death (Phase 1)`, then `npm run build-and-sync`.

### 1F. Update the audit

Open `ARCHITECTURE-AUDIT-2026-04-19.md`, find the table at `:124-138`, and change Phase 1's row to `| 1 | … | ~55 | 1 hr | ✅ **Done** |`. Optionally add a post-mortem note under "Verified ground truth" at `:283`.

### Anti-pattern guards for Phase 1
- Do NOT introduce a new "mark pending rows X" helper to replace the drain. The point is the rows stay `pending`.
- Do NOT add a TODO to "restore the drain later if it turns out to be needed." If retry creates real pain, address it in Phase 3 (queue state machine) — not here.
- Do NOT catch/rethrow the parser's strict reject with a fallback. `continue` is the contract.
- Do NOT return `400` via `res.status(400)` for the Chroma guards — `SearchManager` is called from the MCP handler, not Express. The `{ content: [{ type: 'text', text: ... }] }` shape is what the MCP client renders. Follow the audit's exact snippet shape.

---

## Phase 2 — Prompt + `getActiveAgent` dedup (~125 LOC)

**Goal**: one `buildPrompt(session, mode, isFirst)` for init/continuation; one `getActiveAgent()` shared between `worker-service.ts` and `SessionRoutes.ts`.

### Ground truth (pre-verified)
- `src/sdk/prompts.ts:43` — `buildInitPrompt(project, sessionId, userPrompt, mode)`.
- `src/sdk/prompts.ts:198` — `buildContinuationPrompt(userPrompt, promptNumber, contentSessionId, mode)`.
- Both callers switch on `promptNumber === 1` vs `> 1`:
  - `SDKAgent.ts:352-353`
  - `GeminiAgent.ts:157-158`
  - `OpenRouterAgent.ts:108-109`
- `getActiveAgent()` duplicated at:
  - `src/services/worker-service.ts:635` (silent fallback — returns SDK if none configured)
  - `src/services/worker/http/routes/SessionRoutes.ts:57` (throws if none configured)

### Tasks
1. In `src/sdk/prompts.ts`, write `buildPrompt(session, mode, isFirstPrompt)` that returns the init prompt when `isFirstPrompt` else the continuation prompt. Keep `buildInitPrompt` and `buildContinuationPrompt` as **un-exported** helpers (private to the module) — or inline them into `buildPrompt` if the audit's "5 lines of diff" claim holds up. Re-export only `buildPrompt`.
2. Update the 3 agent call sites to use the single entry point: `buildPrompt(session, mode, session.lastPromptNumber === 1)`.
3. Decide one behavior for `getActiveAgent()`: **throw** when no provider is configured (the SessionRoutes version). Silent fallback to SDK hid the luma "OpenRouter never configured → silent SDK dependency" class of bug. Move it to `src/services/worker/AgentSelector.ts` (new, ~40 LOC) and import from both sites.
4. Audit the 3 agents for any other call sites of `buildInitPrompt`/`buildContinuationPrompt` before deleting exports — grep confirms only the 3 per-agent sites listed above, but re-run to be safe.

### Verification
- `npx tsc --noEmit` clean.
- `npm test` — especially agent-selection + provider-switching tests.
- Smoke: drive a fresh session (first prompt) and a continuation through each configured provider (SDK + whichever else is enabled). Confirm output XML matches previous behavior (compare observation counts pre/post on the same deterministic input if available).

### Anti-pattern guards
- Do NOT keep both `buildInitPrompt` / `buildContinuationPrompt` public after the collapse. Delete the exports so the next engineer isn't confused about which to call.
- Do NOT "ease" `getActiveAgent` with a `console.warn` silent fallback. Throw.

---

## Phase 3 — Queue state machine simplification (~60 LOC + endpoint cleanup)

**Goal**: delete dead `'processed'` enum state, collapse the four `resetStale*` / `reset*Stuck*` methods, collapse the three duplicate `count*` methods in `SessionManager`.

### Tasks
1. Grep for writes to `status = 'processed'` — audit claims zero. Confirm via:
   ```
   rg "status\s*=\s*'processed'" src/
   ```
   If no writes: delete the enum value, delete `getRecentlyProcessed` (~16 LOC), drop the `'processed'` branches from any `switch`/`if` readers.
2. Collapse `resetStaleProcessingMessages`, `resetProcessingToPending`, `retryAllStuck`, `resetStuckMessages` into a single `recoverStaleProcessing(thresholdMs = 60_000)` method. Update call sites. (Audit at `ARCHITECTURE-AUDIT-2026-04-19.md:168` claims ~22 LOC savings in `PendingMessageStore` from this.)
3. In `SessionManager`, collapse `hasPendingMessages`, `getTotalQueueDepth`, `getTotalActiveWork`, `isAnySessionProcessing` into a single `getQueueStatus()` returning `{ pending, processing, total }`. Update `BackgroundInitializer` / `SessionRoutes` read sites.
4. Delete `markSessionMessagesFailed` (`PendingMessageStore.ts:271-285`) — the `terminateSession` caller from Phase 1 was its only useful user; session-level failure is now a session-record concern (via `markSessionCompleted`), not a per-message concern.

### Verification
- `npm test` — queue lifecycle + retry tests.
- Insert a "stuck processing" row manually in the dev DB (SQLite `UPDATE pending_messages SET status='processing', claimed_at_epoch = <old>`); restart worker; confirm `recoverStaleProcessing` flips it back to `pending` on startup.
- Confirm no code paths still call the removed methods: `rg "markSessionMessagesFailed|resetStale|resetProcessingToPending|retryAllStuck|resetStuckMessages|hasPendingMessages|getTotalQueueDepth|getTotalActiveWork|isAnySessionProcessing"` returns zero after the refactor.

### Anti-pattern guards
- Do NOT introduce a new "failed" terminal state. Exhausted retries → `DELETE FROM pending_messages` silently (debug log only).
- Do NOT keep any of the collapsed methods as thin aliases "for backwards compat." Nothing outside the worker uses them.

---

## Phase 4 — Delete FTS5 (~200 LOC)

**Goal**: remove the 6 FTS triggers that fire on every observation insert. Chroma owns search.

### Pre-read
- `src/services/sqlite/SessionSearch.ts:21-22, 40-56` — explicit comment "FTS5 tables are maintained for backward compatibility but not used for search."
- Grep `CREATE TRIGGER` in `src/services/sqlite/` — find the 6 triggers the audit references; also the FTS virtual tables (`observations_fts`, etc.).

### Tasks
1. Write a new migration (numbered one past the current max) that `DROP TRIGGER`s the 6 FTS triggers and `DROP TABLE`s the FTS virtual tables.
2. Delete the dead branches inside `SessionSearch.ts` that reference FTS (the file's own comments flag them).
3. Audit `migrations.ts` + `MigrationRunner` + `SessionStore` constructor for any CREATE TRIGGER / CREATE VIRTUAL TABLE statements that would re-create FTS on a fresh DB. Either delete them (preferred — new DBs should never see FTS) or wrap in an early `DROP IF EXISTS` safety net.

### Verification
- Fresh-DB boot: delete `.docker-claude-mem-data`, start worker, confirm no FTS tables/triggers exist:
  ```
  docker exec claude-mem-luma sqlite3 ~/.claude-mem/claude-mem.db \
    ".schema" | grep -iE "fts|trigger"
  ```
  Expect empty output (or only the non-FTS triggers you meant to keep).
- Existing-DB boot (on a copy of production state): confirm migration ran and FTS artifacts are gone.
- Drive a full session through; confirm observations persist + are searchable via Chroma (the MCP `search` endpoint).

### Anti-pattern guards
- Do NOT leave "empty placeholder" FTS tables "in case we want them back." Delete.
- Do NOT ship this phase without running it against a restored copy of production state — a flawed migration can brick real users. Back up `.docker-claude-mem-data` before first run.

---

## Phase 5 — Collapse context generation (9 classes → 1 file, ~900 LOC)

**Goal**: `ContextBuilder → ObservationCompiler → TokenCalculator → (AgentFormatter | HumanFormatter) → 4 Renderers` collapses to one `generateContext(observations, summaries, config, forHuman): string` at ~200 LOC.

### Pre-read
- Find the files: `rg -l "ContextBuilder|ObservationCompiler|TokenCalculator|AgentFormatter|HumanFormatter|HeaderRenderer|SummaryRenderer|TimelineRenderer|FooterRenderer" src/` (audit counts 1,624 LOC across 9 classes).
- Identify the single entry point callers use today (likely `ContextBuilder.build(...)` or equivalent — map before refactoring).
- Salvage list: `buildTimeline`, `calculateTokenEconomics` (audit `:248`).

### Tasks
1. Write new `src/services/worker/context/generateContext.ts` (~200 LOC) with a single exported function. Compose the markdown inline — headers, summaries, timeline, footer — with two branches for agent-vs-human output.
2. Replace all callers of the old entry point with `generateContext(...)`.
3. Delete the 9 class files once callers are migrated.
4. Move `buildTimeline` / `calculateTokenEconomics` into `generateContext.ts` as local helpers (or leave as their own small modules if reused elsewhere — grep first).

### Verification
- Snapshot test: before starting, capture the output of the old pipeline for N representative sessions (different observation counts, token budgets, agent+human modes). After the refactor, diff new output vs snapshot. Difference should be zero whitespace-normalized.
- Viewer smoke: open `http://localhost:37779/` and render a session summary; confirm identical visual output.

### Anti-pattern guards
- Do NOT introduce any new classes. One function, plain string building.
- Do NOT "migrate gradually" by keeping both the old pipeline and the new function side-by-side behind a flag. Cutover in the same commit.

---

## Ordering & commit cadence

- One commit per phase. No mega-commits. Commit messages:
  - Phase 1: `fix: stop draining pending messages on session death (Phase 1)`
  - Phase 2: `refactor: unify prompt builder and agent selector (Phase 2)`
  - Phase 3: `refactor: simplify queue state machine (Phase 3)`
  - Phase 4: `chore: delete dead FTS5 subsystem (Phase 4)`
  - Phase 5: `refactor: collapse context generation pipeline (Phase 5)`
- After each phase commit: update the execution-plan table in `ARCHITECTURE-AUDIT-2026-04-19.md:124-138` (`✅ Done`).
- `npm run build-and-sync` cadence: only after each phase passes its own verification. Phase 1 has a mandatory luma-container smoke test before any sync.

---

## Final verification (after Phase 5)

1. LOC delta: `git diff --stat main...HEAD -- src/ | tail -1` should show a net deletion within ~10% of the audit's 1,340-LOC fast-path estimate.
2. Insert-path perf: time 1000 observation inserts pre and post Phase 4. Expect measurable improvement (6 fewer triggers per row).
3. Re-run the full test suite + luma smoke test. Zero regressions.
4. Update `ARCHITECTURE-AUDIT-2026-04-19.md` post-mortem: what the audit predicted vs what shipped, any surprises.

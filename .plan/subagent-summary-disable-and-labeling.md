# Plan: Disable Summaries for Subagents + Label Subagent Observations

## Goal

1. **Disable summaries for subagents** — prevent any summary generation path (hook → worker → SDK agent) from firing for events originating in a Claude Code subagent.
2. **Label observations from subagents** — tag every observation with the subagent identity (agent_id + agent_type) so downstream queries can distinguish main-session work from subagent work.

## Phase 0 — Documentation Discovery (COMPLETE)

### Claude Code hook payload fields (source: https://code.claude.com/docs/en/hooks.md)

- `agent_id` — present **only** when the hook fires inside a subagent invocation (e.g., `"agent-def456"`). Absent in the main session.
- `agent_type` — the subagent identifier (built-in like `"Bash"`, `"Explore"`, `"Plan"`, or a custom agent name). Present in subagents **and** when `--agent` flag is used.
- `session_id` — shared across main and subagents in the same session. Cannot distinguish contexts on its own.
- `transcript_path` — shared session transcript. Not a reliable discriminator.
- `SubagentStop` — dedicated event that fires when a subagent finishes. Currently **NOT registered** in `plugin/hooks/hooks.json`.
- `Stop` — fires for the main Claude agent (not subagents). Currently registered → wired to `summarize` handler.

**Discriminator for subagent context**: presence of `agent_id` OR `agent_type` in the hook stdin JSON.

### Current claude-mem architecture (grepped + read)

- `src/cli/types.ts:1-15` — `NormalizedHookInput` lacks `agentId` / `agentType`.
- `src/cli/adapters/claude-code.ts:5-17` — Claude Code adapter does NOT extract `agent_id` / `agent_type`.
- `src/cli/handlers/summarize.ts:27-143` — Stop-hook handler posts to `/api/sessions/summarize` without guarding on subagent context.
- `src/cli/handlers/observation.ts:51-62` — PostToolUse handler POSTs observation body without subagent fields.
- `src/services/worker/http/routes/SessionRoutes.ts:555-646` — `handleObservationsByClaudeId` destructures only `{ contentSessionId, tool_name, tool_input, tool_response, cwd }`; `queueObservation` call at line 620 has no subagent field.
- `src/services/sqlite/observations/store.ts:75-80` — `INSERT INTO observations` column list has no `agent_type` / `agent_id`.
- `src/services/sqlite/migrations.ts:578-588` — migrations array ends with `migration009` (version 26). Next migration slot is `migration010` (version 27).
- `src/utils/logger.ts:195-203` — already reads `input.subagent_type` for formatting Task tool invocations (reference pattern, no downstream storage).

### Allowed APIs / patterns to copy

- **Adapter metadata extension pattern**: `src/cli/adapters/gemini-cli.ts:77-96` already collects platform-specific metadata into `metadata` and returns it on `NormalizedHookInput`. Copy this pattern.
- **Migration pattern**: `src/services/sqlite/migrations.ts:556-573` (migration009) is a copy-ready template for conditional `ALTER TABLE ADD COLUMN` additions.
- **Observation INSERT column extension pattern**: `src/services/sqlite/observations/store.ts:75-98` — add `agent_type`, `agent_id` to the column list and to `stmt.run(...)` bindings.

### Anti-patterns to avoid

- Do NOT assume `agent_id` is present on the main session — it is undefined there. Treat presence as the discriminator.
- Do NOT register SubagentStop as a new hook in `hooks.json` just to "disable" summaries — defensively short-circuiting in the handler is simpler and covers both current and future Claude Code versions where Stop might fire in subagent contexts.
- Do NOT rely on `session_id` to distinguish — it is shared.
- Do NOT invent a `parent_tool_use_id` field in hook input. The Claude Code docs do not expose parent tool use ID on hook payloads. Only use `agent_id` + `agent_type`.
- Do NOT break the existing observation hash-dedup logic in `store.ts:19-28` — leave the hash inputs as-is.

---

## Phase 1 — Extend hook input surface to carry subagent fields

**What to implement** (COPY pattern from gemini-cli adapter metadata handling):

1. Edit `src/cli/types.ts:1-15` — add two optional fields to `NormalizedHookInput`:
   ```ts
   agentId?: string;      // Claude Code subagent agent_id (undefined in main session)
   agentType?: string;    // Claude Code subagent agent_type (undefined in main session)
   ```

2. Edit `src/cli/adapters/claude-code.ts:5-17` — in `normalizeInput`, extract `r.agent_id` and `r.agent_type`:
   ```ts
   return {
     sessionId: r.session_id ?? r.id ?? r.sessionId,
     cwd: r.cwd ?? process.cwd(),
     prompt: r.prompt,
     toolName: r.tool_name,
     toolInput: r.tool_input,
     toolResponse: r.tool_response,
     transcriptPath: r.transcript_path,
     agentId: typeof r.agent_id === 'string' ? r.agent_id : undefined,
     agentType: typeof r.agent_type === 'string' ? r.agent_type : undefined,
   };
   ```

3. Edit `src/cli/adapters/gemini-cli.ts:88-97` — return matching `undefined` defaults so the interface contract is consistent across adapters. (No behavior change; just explicit `agentId: undefined, agentType: undefined` on the return object, or rely on the optional-field default by leaving it out. Leave it out — TypeScript optional is fine.)

**Documentation references**: Claude Code hooks docs section "Subagent Identification Fields"; gemini-cli adapter metadata pattern at `src/cli/adapters/gemini-cli.ts:77-96`.

**Verification checklist**:
- `grep -n "agentId" src/cli/types.ts` → finds the new field.
- `grep -n "agent_id" src/cli/adapters/claude-code.ts` → finds the extraction.
- `npm run build` succeeds.

**Anti-pattern guards**:
- Do NOT rename `agent_id` / `agent_type` snake_case raw fields. Camel-case only in `NormalizedHookInput`.
- Do NOT default to a sentinel string like `"main"`; leave undefined when absent.

---

## Phase 2 — Short-circuit summary generation in subagent context

**What to implement**:

1. Edit `src/cli/handlers/summarize.ts:27-36`, immediately after the worker-ready check (line 34) and before any processing:
   ```ts
   // Skip summaries in subagent context — subagents do not own the session summary.
   // Main Stop hook owns it; SubagentStop (if ever registered) must no-op.
   if (input.agentId || input.agentType) {
     logger.debug('HOOK', 'Skipping summary: subagent context detected', {
       sessionId: input.sessionId,
       agentId: input.agentId,
       agentType: input.agentType
     });
     return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
   }
   ```

2. (Safety) Edit `src/services/worker/http/routes/SessionRoutes.ts` in `handleSummarizeByClaudeId` (around line 655-692): add a defensive guard that rejects the summarize request if the body includes `agentId` or `agentType`. Return `{ status: 'skipped', reason: 'subagent_context' }`. This is belt-and-suspenders in case any caller bypasses the hook layer.

3. Extend the `/api/sessions/summarize` body in `src/cli/handlers/summarize.ts:73-82` to include `agentId` and `agentType` (passthrough) so the worker can make the same decision independently. Only pass fields when defined:
   ```ts
   body: JSON.stringify({
     contentSessionId: sessionId,
     last_assistant_message: lastAssistantMessage,
     platformSource,
     ...(input.agentId ? { agentId: input.agentId } : {}),
     ...(input.agentType ? { agentType: input.agentType } : {}),
   }),
   ```

**Documentation references**: summarize.ts handler flow at `src/cli/handlers/summarize.ts:27-143`; summarize route at `src/services/worker/http/routes/SessionRoutes.ts:655-692`.

**Verification checklist**:
- Unit test or manual dispatch with a payload containing `agent_id: "agent-abc"` → summarize handler returns before calling `/api/sessions/summarize`.
- `grep -n "subagent" src/cli/handlers/summarize.ts` → finds the new guard.
- `grep -n "subagent_context\|agentId" src/services/worker/http/routes/SessionRoutes.ts` → finds the server-side guard.

**Anti-pattern guards**:
- Do NOT also short-circuit in `session-complete` or `context` handlers — the session's main Stop still cleans up.
- Do NOT log at info level (spammy); `logger.debug` only.

---

## Phase 3 — Database schema migration for subagent labels on observations

**What to implement** (COPY migration009 pattern from `src/services/sqlite/migrations.ts:556-573`):

1. Append a new migration to `src/services/sqlite/migrations.ts` right after `migration009` (before the `migrations` array at line 578):
   ```ts
   export const migration010: Migration = {
     version: 27,
     up: (db: Database) => {
       const columns = db.prepare('PRAGMA table_info(observations)').all() as any[];
       const hasAgentType = columns.some((c: any) => c.name === 'agent_type');
       const hasAgentId = columns.some((c: any) => c.name === 'agent_id');
       if (!hasAgentType) {
         db.run('ALTER TABLE observations ADD COLUMN agent_type TEXT');
       }
       if (!hasAgentId) {
         db.run('ALTER TABLE observations ADD COLUMN agent_id TEXT');
       }
       db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)');
       console.log('[migration010] Added agent_type, agent_id columns to observations');
     },
     down: (_db: Database) => {
       // SQLite DROP COLUMN not fully supported; no-op
     }
   };
   ```

2. Add `migration010` to the `migrations` array at `src/services/sqlite/migrations.ts:578-588`.

3. Check `src/services/sqlite/migrations/runner.ts` to see if there's a parallel registration site; if so, mirror the addition there. (Investigation step — if `runner.ts` replicates migration definitions, extend it the same way. Otherwise, importing `migrations` from `migrations.ts` is sufficient.)

**Documentation references**: migration007 and migration009 at `src/services/sqlite/migrations.ts:491-509` and `556-573` as copy-ready templates.

**Verification checklist**:
- Run worker; check logs for `[migration010]`.
- `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA table_info(observations);"` → shows `agent_type` and `agent_id` columns.
- `sqlite3 ~/.claude-mem/claude-mem.db ".indexes observations"` → shows `idx_observations_agent_type`.

**Anti-pattern guards**:
- Do NOT drop or rename existing columns.
- Do NOT set NOT NULL constraints — main-session rows have NULL for these.
- Do NOT pick a version number that's already used (26 is migration009; use 27).

---

## Phase 4 — Thread subagent fields through hook → worker → SDK → DB

**What to implement**:

### 4a — Hook PostToolUse handler sends fields

Edit `src/cli/handlers/observation.ts:51-62`:
```ts
const response = await workerHttpRequest('/api/sessions/observations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contentSessionId: sessionId,
    platformSource,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    cwd,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.agentType ? { agentType: input.agentType } : {}),
  })
});
```

### 4b — Worker observations route receives and forwards

Edit `src/services/worker/http/routes/SessionRoutes.ts:555-646`:
- Destructure: `const { contentSessionId, tool_name, tool_input, tool_response, cwd, agentId, agentType } = req.body;`
- Pass to `queueObservation` at line 620:
  ```ts
  this.sessionManager.queueObservation(sessionDbId, {
    tool_name,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    prompt_number: promptNumber,
    cwd: cwd || ...,
    agentId: typeof agentId === 'string' ? agentId : undefined,
    agentType: typeof agentType === 'string' ? agentType : undefined,
  });
  ```

### 4c — queueObservation type extension

Investigation: find the `queueObservation` signature in the session manager (likely `src/services/session/` or similar). Add optional `agentId?: string; agentType?: string;` to the payload type. These must ride through to the SDK agent's observation context so they land in `storeObservation()`.

### 4d — Observation input type + store.ts extension

- Edit `src/services/sqlite/observations/types.ts:10-19` — add:
  ```ts
  agent_type?: string | null;
  agent_id?: string | null;
  ```
- Edit `src/services/sqlite/observations/store.ts:75-98`:
  - Column list: add `, agent_type, agent_id` before `content_hash`.
  - Placeholders: add `, ?, ?`.
  - Bindings: add `observation.agent_type ?? null, observation.agent_id ?? null`.
- Verify there are no other `INSERT INTO observations` sites that need updating. Sites already located (to re-check):
  - `src/services/sqlite/SessionStore.ts:1755` / `1890` / `2022` / `2623` — each needs the same two columns added. If these are separate insertion paths, extend all of them; pass `null` for fields not available in that path.

### 4e — SDK agent observation parser forwards fields

The SDK agent parses `<observation>` XML into an `ObservationInput` and calls `storeObservation`. The tool_input passed in must carry `agentId`/`agentType` through to here so the row gets labeled. Investigation step: find where `storeObservation()` is called with an `ObservationInput` built from the queued observation, and inject `agent_type`/`agent_id` from the queue item's subagent fields onto the `ObservationInput`. Location likely in `src/services/sdk/` or adjacent.

**Documentation references**:
- observation handler at `src/cli/handlers/observation.ts:51-62`
- SessionRoutes observations endpoint at `src/services/worker/http/routes/SessionRoutes.ts:555-646`
- storeObservation at `src/services/sqlite/observations/store.ts:75-98`
- Existing observation INSERT sites at `src/services/sqlite/SessionStore.ts:1755, 1890, 2022, 2623` (audit required)

**Verification checklist**:
- `grep -rn "agent_type\|agentType" src/` → shows fields threaded through every layer.
- Simulate a Task subagent PostToolUse payload → observation row has non-null `agent_type`.
- Main-session PostToolUse → observation row has NULL `agent_type` (existing behavior preserved).
- No existing test suite breaks: `npm test` passes.

**Anti-pattern guards**:
- Do NOT include `agent_type` / `agent_id` in the content-hash computation (`src/services/sqlite/observations/store.ts:19-28`). The hash identity must remain stable for dedup.
- Do NOT add fields to the FTS5 `observations_fts` virtual table — not searchable text.
- Do NOT backfill — leave existing rows NULL.

---

## Phase 5 — Tests and verification

**What to implement**:

1. Add a unit test at `tests/cli/handlers/summarize-subagent-skip.test.ts` verifying:
   - When `input.agentId` is set, handler returns early with `exitCode: SUCCESS` and does NOT call `workerHttpRequest`.
   - When `input.agentType` is set, same behavior.
   - When both are undefined, handler proceeds (mock worker response).

2. Add a unit test at `tests/cli/adapters/claude-code-subagent.test.ts` verifying:
   - `normalizeInput({ agent_id: "agent-abc", agent_type: "Explore" })` returns `{ agentId: "agent-abc", agentType: "Explore" }`.
   - `normalizeInput({})` returns `agentId: undefined, agentType: undefined`.

3. Add a unit test at `tests/services/sqlite/observations/store-subagent-label.test.ts` verifying:
   - `storeObservation` with `agent_type: "Explore"` inserts row with `agent_type = "Explore"`.
   - Omitted `agent_type` → NULL in DB.
   - Content-hash dedup still works (two observations with same title/narrative but different `agent_type` should still collide on dedup — verify expected behavior; update test if product intent differs).

4. Manual integration check: start worker, simulate a hook payload with `agent_id`/`agent_type`, observe observation row in DB.

**Verification checklist**:
- `npm test` passes.
- `npm run build` succeeds.
- Database inspection shows expected rows.

**Anti-pattern guards**:
- Do NOT mock the entire storeObservation — use a real in-memory Bun SQLite DB if existing tests do.
- Do NOT add integration tests that require a running worker unless the suite already does.

---

## Phase 6 — Build + autonomous execution pipeline

After Phases 1-5 land and pass verification:

1. **Build**: `npm run build-and-sync`.
2. **Commit**: a single commit titled `feat: disable subagent summaries and label subagent observations` with co-author footer.
3. **Push branch**: push current worktree branch `trail-guarantee` (or a new feature branch — confirm with `git status`). Create PR via `gh pr create` with summary of both features.
4. **Run `/loop 5m`** to continuously re-check PR review comments: as each CodeRabbit/Greptile/human comment arrives, address it in a new commit, push, and re-check. Exit loop only when all actionable review comments are resolved and status checks pass.
5. **Merge to main** via `gh pr merge --squash --auto` (or `--merge` per repo convention — inspect `.github/` first).
6. **Version bump**: `cd ~/Scripts/claude-mem/` and run `/version-bump`.

**Anti-pattern guards for this phase**:
- Do NOT force-push to main.
- Do NOT skip hooks (`--no-verify`).
- Do NOT squash-merge if the repo uses rebase-merge; check `.github/` for branch-protection hints.
- Do NOT resolve a review comment without actually addressing it — every resolved thread must have a corresponding commit or a reply explaining why no change is needed.

---

## Final Verification (end of Phase 5, before Phase 6)

- `grep -rn "agent_id\|agentId" src/` → fields present in: `types.ts`, `claude-code.ts`, `summarize.ts`, `observation.ts`, `SessionRoutes.ts`, observation types, store, migration010.
- `grep -rn "subagent_context" src/services/worker/` → worker-side guard present.
- `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA table_info(observations);"` → includes `agent_type`, `agent_id`.
- `npm test && npm run build` → both green.
- Smoke test: simulate a subagent hook payload end-to-end → observation labeled, no summary fired.

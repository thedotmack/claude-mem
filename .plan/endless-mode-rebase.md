# Plan: Endless Mode Re-implementation on Current Main

## Context

Endless mode was implemented on `beta/endless-mode` branch (diverged at v7.0.0). Main is now at v10.4.1 — **902 commits ahead**. Rebasing is impractical. This plan re-implements endless mode on top of current main, using the old branch as a reference for concepts only.

### What Endless Mode Does

When enabled, after each tool execution:
1. The PostToolUse hook waits for the SDK agent to process the observation
2. The processed observation (title, narrative, facts) is injected back into Claude's context via `additionalContext`
3. Large tool inputs are cleared from the transcript to save tokens
4. Net effect: Claude sees compressed observations instead of raw tool data → extends effective context window

### Key Problem from Previous Attempt

The save-hook blocked for 60-90s waiting for SDK processing, making sessions unusably slow. The fundamental tension: AI-processed observations require time, but hooks have a 120s hard limit.

### Branch Strategy

Create a new branch `feature/endless-mode-v2` from current main. Do NOT touch the old `beta/endless-mode` branch.

---

## Phase 0: Documentation Discovery (Reference Gathering)

### 0.1 — Read old branch implementation for reference patterns
- `git show beta/endless-mode:src/hooks/save-hook.ts` — synchronous wait pattern
- `git show beta/endless-mode:src/hooks/context-injection.ts` — observation formatting
- `git show beta/endless-mode:src/hooks/pre-tool-use-hook.ts` — tool_use_id tracking
- `git show beta/endless-mode:src/services/worker/SessionManager.ts` — `waitForNextObservation()`
- `git show beta/endless-mode:docs/context/state-of-endless.md` — architecture doc

### 0.2 — Read current main integration points
- `src/hooks/hook-response.ts:1-15` — current hook response format
- `src/services/worker/SessionManager.ts:21-100` — current session management
- `src/services/worker/SDKAgent.ts:43-150` — current SDK agent flow, event emission
- `src/services/worker/http/routes/SessionRoutes.ts:498-573` — current observation endpoint
- `src/services/sqlite/SessionStore.ts:1503-1560` — current storeObservation
- `src/shared/SettingsDefaultsManager.ts:77-133` — current settings defaults

### 0.3 — Identify Claude Code hook contract
- `plugin/plugin.json` — current hook configuration (which hooks exist, their types)
- Check if `PreToolUse` hook type is available in Claude Code plugin spec
- Check `additionalContext` field availability in hook response contract

### Deliverable
List of exact APIs, file locations, and patterns available for each integration point. Anti-pattern list of methods that existed on the old branch but don't exist on current main.

---

## Phase 1: Database Schema — Add `tool_use_id` Column

### What to implement
- Add migration 20 to `src/services/sqlite/SessionStore.ts` (after migration 19 at ~line 53)
- Add nullable `tool_use_id TEXT` column to observations table
- Add index: `CREATE INDEX idx_observations_tool_use_id ON observations(tool_use_id)`
- Add `getObservationsByToolUseId(toolUseId: string)` method to SessionStore
- Update `storeObservation()` signature to accept optional `tool_use_id?: string`

### Files to modify
- `src/services/sqlite/SessionStore.ts` — migration + store method
- `src/services/sqlite/observations/types.ts` — add tool_use_id to StoreObservationResult
- `src/types/transcript.ts` — verify ToolResultContent.tool_use_id matches Claude's format

### Verification
- `npm run build` succeeds
- Worker starts without errors
- New column appears in observations table: `sqlite3 ~/.claude-mem/claude-mem.db ".schema observations"`

### Anti-patterns
- Do NOT make tool_use_id NOT NULL — old observations won't have it
- Do NOT modify existing migrations — only append new ones

---

## Phase 2: Settings — Add Endless Mode Configuration

### What to implement
- Add to `SettingsDefaultsManager.ts` DEFAULTS (~line 77):
  - `CLAUDE_MEM_ENDLESS_MODE`: `'false'` (disabled by default)
  - `CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS`: `'90000'` (90 second timeout)
- Add helper method `isEndlessModeEnabled(): boolean`

### Files to modify
- `src/shared/SettingsDefaultsManager.ts`

### Verification
- Settings load correctly with defaults
- Can override via `~/.claude-mem/settings.json`
- Can override via environment variable

### Anti-patterns
- Do NOT add UI for toggling yet — settings.json is sufficient for beta

---

## Phase 3: Worker-Side — Event-Based Observation Completion Signaling

### What to implement
- In `SessionManager.ts`: Add `waitForNextObservation(sessionDbId, toolUseId, timeoutMs)` method
  - Uses existing `sessionQueues` EventEmitter infrastructure
  - Waits for `observation_saved` event matching toolUseId
  - Returns the observation or null on timeout
- In `SDKAgent.ts`: After `storeObservation()` call, emit `observation_saved` event with observation data and toolUseId
- In `SessionRoutes.ts`:
  - Accept `tool_use_id` in observation POST body
  - Accept `wait_until_observation_is_saved=true` query parameter
  - When waiting: call `SessionManager.waitForNextObservation()` before responding
  - When not waiting (default): existing fire-and-forget behavior

### Files to modify
- `src/services/worker/SessionManager.ts`
- `src/services/worker/SDKAgent.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`

### Verification
- Worker builds and starts
- Default (non-endless) observation flow is unaffected
- Can POST with `wait_until_observation_is_saved=true` and get observation back in response

### Anti-patterns
- Do NOT add SSE/streaming — simple HTTP request/response with await is sufficient
- Do NOT modify the existing fire-and-forget path — only add the new waiting path
- Do NOT add a pre-tool-use endpoint yet — tool_use_id comes from the hook, not a separate call

---

## Phase 4: Hook-Side — PostToolUse Synchronous Injection

### What to implement
- Modify the PostToolUse hook (save-hook) to:
  1. Check if endless mode is enabled via settings
  2. Extract `tool_use_id` from the hook input (Claude Code provides this)
  3. If endless mode ON: POST observation with `wait_until_observation_is_saved=true` and `tool_use_id`
  4. Receive processed observation in HTTP response
  5. Format observation as markdown (copy pattern from old `context-injection.ts`)
  6. Return hook response with `additionalContext` field containing formatted observation
  7. If endless mode OFF: existing fire-and-forget behavior (unchanged)
- Create `src/hooks/observation-formatter.ts` utility for markdown formatting

### Files to modify
- `src/hooks/save-hook.ts` (or whatever the current PostToolUse hook source is)
- `src/hooks/observation-formatter.ts` (NEW)
- `src/hooks/hook-response.ts` — add `additionalContext` support to response type

### Verification
- With endless mode OFF: behavior identical to current
- With endless mode ON: observations appear in Claude's context after tool use
- Hook respects 120s Claude Code timeout (90s observation wait + buffer)

### Anti-patterns
- Do NOT add transcript clearing in this phase — that's a separate optimization
- Do NOT block indefinitely — always use timeout with graceful fallback
- Do NOT swallow errors in the wait path — if it fails, fall back to fire-and-forget

---

## Phase 5: Build, Test, and Validate

### What to implement
- `npm run build-and-sync` — full build
- Manual testing:
  1. Enable endless mode in settings.json
  2. Start a Claude Code session
  3. Execute tool uses and verify observations appear in context
  4. Verify non-endless mode is unaffected
- Add basic unit tests in `tests/endless-mode/`

### Verification checklist
- [ ] `npm run build` succeeds with zero errors
- [ ] Worker starts without errors
- [ ] Non-endless mode behavior unchanged (regression check)
- [ ] With endless mode ON: observation appears in Claude's context after tool use
- [ ] Timeout fallback works (kill worker mid-processing, verify graceful degradation)
- [ ] Settings toggle works (on/off without restart)
- [ ] Database migration applies cleanly on fresh and existing databases

### Anti-patterns
- Do NOT ship to npm/release yet — this is beta
- Do NOT add documentation updates yet — feature must be validated first
- Do NOT add telemetry or analytics in initial implementation

---

## Phase 6: Transcript Clearing Optimization (Optional, After Validation)

### What to implement
- After observation injection is working, add transcript clearing:
  - After successful observation injection, clear the large `tool_input` from Claude's transcript JSONL
  - This is the actual token savings mechanism — compressed observation replaces raw tool data
- Read from old branch: `git show beta/endless-mode:src/hooks/context-injection.ts` for `clearToolInputInTranscript()`

### Files to modify
- `src/hooks/save-hook.ts` — add transcript clearing after successful injection
- `src/hooks/transcript-clearer.ts` (NEW) — utility for JSONL manipulation

### Verification
- Token count decreases after observation injection
- Transcript JSONL remains valid after clearing
- Claude Code doesn't break when transcript entries are modified

### Anti-patterns
- Do NOT clear transcript if observation injection failed — leave raw data intact
- Do NOT modify transcript entries other than the current tool use
- Do NOT implement until Phase 5 validation is complete

---

## Decisions Needed from User

1. **Branch name**: `feature/endless-mode-v2` (proposed) — acceptable?
2. **Scope**: Phases 1-5 are core. Phase 6 is optional. Should Phase 6 be included?
3. **Pre-tool-use hook**: The old branch had a separate PreToolUse hook to send tool_use_id before execution. The PostToolUse hook already receives tool_use_id from Claude Code. Do we need PreToolUse, or is PostToolUse sufficient?

# Plan: Fix Plan Mode Pending Message Accumulation (#1137)

## Problem Summary

Plan mode in Claude Code causes rapid PostToolUse hook firing (Read, Glob, Grep) and multiple Stop events, flooding the pending message queue. Combined with the crash recovery gap, messages get stuck in `processing` status permanently.

## Phase 0: Documentation Discovery (Complete)

### Relevant Architecture
- **Hook input flows**: `stdin JSON → claude-code adapter → NormalizedHookInput → handler → HTTP POST to worker`
- **`permission_mode`**: Claude Code sends this field in hook stdin JSON, but it is **not captured** by the adapter (`src/cli/adapters/claude-code.ts:6-17`) or the type (`src/cli/types.ts:1-13`)
- **Message queuing**: `SessionRoutes.ts:468-551` (observations) and `SessionRoutes.ts:560-596` (summarize)
- **Stuck recovery**: `PendingMessageStore.resetStaleProcessingMessages()` called only at startup (`worker-service.ts:407`)
- **No deduplication**: Summarize messages queue without checking for recent duplicates

### Key Files
| File | Purpose |
|------|---------|
| `src/cli/types.ts` | `NormalizedHookInput` interface |
| `src/cli/adapters/claude-code.ts` | Maps raw Claude Code stdin → normalized input |
| `src/cli/handlers/observation.ts` | PostToolUse hook handler |
| `src/cli/handlers/summarize.ts` | Stop hook handler |
| `src/services/worker/http/routes/SessionRoutes.ts` | Worker API endpoints |
| `src/services/sqlite/PendingMessageStore.ts` | Queue operations |
| `src/services/worker/SessionManager.ts` | Queue management |
| `src/services/worker-service.ts` | Worker lifecycle |

---

## Phase 1: Plan Mode Filtering at Hook Layer

**Goal**: Skip queuing read-only tool observations when Claude is in plan mode. This is the highest-impact fix since plan mode exploration fires dozens of Read/Glob/Grep calls.

### Tasks

1. **Add `permissionMode` to `NormalizedHookInput`** (`src/cli/types.ts:1-13`)
   - Add optional field: `permissionMode?: string;`

2. **Capture `permission_mode` in claude-code adapter** (`src/cli/adapters/claude-code.ts:6-17`)
   - Add `permissionMode: r.permission_mode,` to the return object at line 16

3. **Filter read-only plan mode observations** (`src/cli/handlers/observation.ts`)
   - After line 24 (destructuring), check `input.permissionMode`
   - If `permissionMode === 'plan'` AND tool is in `['Read', 'Glob', 'Grep', 'Bash']`, skip with exit 0
   - Log the skip at debug level

4. **Pass `permissionMode` to summarize handler** (`src/cli/handlers/summarize.ts`)
   - Capture `input.permissionMode` at line 26
   - Pass it through to the worker request body (for Phase 2 dedup awareness)

### Verification
- `grep -r "permissionMode" src/cli/` should show the new field in types, adapter, and both handlers
- Build succeeds with `npm run build-and-sync`

### Anti-pattern Guards
- Do NOT filter at the worker layer for this — hook-layer filtering prevents the HTTP call entirely
- Do NOT add a database column for permission_mode — it's a filter decision, not stored data
- Do NOT block ALL observations in plan mode — only read-only exploration tools

---

## Phase 2: Summarize Deduplication at Worker Layer

**Goal**: Prevent multiple summarize messages from queuing within a short time window for the same session. The issue shows 6 summarize messages in 25 seconds.

### Tasks

1. **Add `hasRecentSummarize` method to `PendingMessageStore`** (`src/services/sqlite/PendingMessageStore.ts`)
   - Query: `SELECT id FROM pending_messages WHERE content_session_id = ? AND message_type = 'summarize' AND status IN ('pending', 'processing') AND created_at_epoch > ?`
   - Parameter: `contentSessionId`, `windowMs` (default 30000 = 30 seconds)
   - Returns `boolean`

2. **Check for recent summarize before queuing** (`src/services/worker/http/routes/SessionRoutes.ts:560-596`)
   - In `handleSummarizeByClaudeId`, after privacy check (line 584), before `queueSummarize` (line 587):
   - Call `pendingStore.hasRecentSummarize(contentSessionId, 30000)`
   - If recent summarize exists, return `{ status: 'skipped', reason: 'recent_summarize_pending' }`
   - Log at debug level

### Verification
- Unit test: enqueue 2 summarize messages for same session within 30s, second should be skipped
- `grep -r "hasRecentSummarize" src/` shows method definition and usage

### Anti-pattern Guards
- Do NOT deduplicate observations — they represent distinct tool calls with different content
- Do NOT use time-based dedup longer than 60s — legitimate summarize requests should still queue
- Do NOT delete existing summarize messages — just skip new duplicates

---

## Phase 3: Periodic Stuck Message Recovery

**Goal**: Add runtime interval that resets stale `processing` messages, complementing the startup-only recovery.

### Tasks

1. **Add periodic recovery interval in `worker-service.ts`** (`src/services/worker-service.ts`)
   - In `initializeBackground()`, after the startup reset (line 410), add:
   - `setInterval` that calls `pendingStore.resetStaleProcessingMessages(5 * 60 * 1000)` every 5 minutes
   - Reset messages stuck in `processing` for more than 5 minutes
   - Log reset count at info level when > 0
   - Store the interval handle for cleanup in `shutdown()`

2. **Clean up interval on shutdown** (`src/services/worker-service.ts`)
   - In the `cleanup()` or `shutdown()` method, call `clearInterval()` on the stored handle

### Verification
- `grep -r "setInterval.*resetStale" src/services/worker-service.ts` shows the interval
- Worker logs show periodic recovery check messages (at debug level even when 0 messages reset)

### Anti-pattern Guards
- Do NOT use a threshold shorter than 3 minutes — normal processing can take time for large observations
- Do NOT run the interval more frequently than every 3 minutes — avoid unnecessary DB queries
- Do NOT add a new endpoint for this — it's internal worker health maintenance

---

## Phase 4: Verification

### Checklist
1. Build succeeds: `npm run build-and-sync`
2. Plan mode filtering works:
   - `grep -r "permissionMode" src/cli/` shows types, adapter, observation handler
   - No plan mode Read/Glob/Grep observations hit the worker
3. Summarize dedup works:
   - `grep -r "hasRecentSummarize" src/` shows PendingMessageStore + SessionRoutes
   - Rapid summarize calls within 30s window are skipped
4. Periodic recovery works:
   - `grep -r "setInterval" src/services/worker-service.ts` shows the interval
   - Worker startup logs confirm interval registration
5. No regressions:
   - Normal (non-plan) observations still queue correctly
   - Summarize messages still queue when outside the dedup window
   - Stuck messages are recovered both at startup and periodically

# Phase 2: Query.close() + Crash-Recovery PID Persistence

## Context

SDK 0.2.50 exposes `Query.close(): void` for explicit subprocess cleanup. Currently session cleanup relies solely on `abortController.abort()` + SIGKILL escalation. Two problems:

1. **Happy-path gap**: No explicit SDK-native cleanup call between abort and SIGKILL
2. **Crash-recovery gap**: `ProcessRegistry` tracks PIDs in-memory only. Worker crash loses all PID references, leaving orphan subprocesses that the 5-minute reaper can only find via unreliable `ps` parsing (ppid=1, Unix-only)

This phase adds `Query.close()` for happy-path cleanup AND persists PIDs to SQLite for crash-recovery.

## Changes

### 1. Add `subprocess_pid` column to `sdk_sessions` (`src/services/sqlite/SessionStore.ts`)

Add a migration to the session store:

```sql
ALTER TABLE sdk_sessions ADD COLUMN subprocess_pid INTEGER
```

Add methods:
- `updateSubprocessPid(sessionDbId: number, pid: number): void`
- `clearSubprocessPid(sessionDbId: number): void`
- `getStalePids(): Array<{ sessionDbId: number; pid: number }>` -- returns PIDs for sessions with status='active' that have a non-null PID

### 2. Add `queryRef` to ActiveSession (`src/services/worker-types.ts`)

```typescript
import type { Query } from '@anthropic-ai/claude-agent-sdk';

export interface ActiveSession {
  // ... existing fields ...
  queryRef?: Query;
}
```

### 3. Store query reference + persist PID (`src/services/worker/SDKAgent.ts`)

After `query()`, store the reference:

```typescript
const queryResult = query({ prompt: messageGenerator, options: { ... } });
session.queryRef = queryResult;
```

### 4. Persist PID on spawn (`src/services/worker/ProcessRegistry.ts`)

In `createPidCapturingSpawn()`, after registering in-memory, also persist to DB:

```typescript
registerProcess(child.pid, sessionDbId, child);
// Persist for crash recovery
sessionStore.updateSubprocessPid(sessionDbId, child.pid);
```

This requires passing a `sessionStore` reference to `createPidCapturingSpawn()` or calling the DB update from the caller (`SDKAgent.ts`).

**Preferred approach**: Add a callback parameter to `createPidCapturingSpawn()`:

```typescript
export function createPidCapturingSpawn(
  sessionDbId: number,
  onPidCaptured?: (pid: number) => void
)
```

SDKAgent passes the callback:

```typescript
spawnClaudeCodeProcess: createPidCapturingSpawn(sessionDbId, (pid) => {
  this.dbManager.getSessionStore().updateSubprocessPid(sessionDbId, pid);
}),
```

### 5. Call close() + clear PID in deleteSession (`src/services/worker/SessionManager.ts`)

Updated cleanup flow:

```
1. session.abortController.abort()           -- existing
2. session.queryRef?.close()                 -- NEW: SDK-native cleanup
3. await session.generatorPromise            -- existing
4. ensureProcessExit(tracked, 5s)            -- existing (SIGKILL safety net)
5. sessionStore.clearSubprocessPid(id)       -- NEW: clear persisted PID
6. this.sessions.delete(sessionDbId)         -- existing
```

Wrap `close()` in try/catch (may throw if already closed).

### 6. Kill stale PIDs on worker startup (`src/services/worker-service.ts`)

In `initializeBackground()`, before `processPendingQueues()`:

```typescript
// Kill stale subprocess PIDs from crashed sessions
const stalePids = dbManager.getSessionStore().getStalePids();
for (const { sessionDbId, pid } of stalePids) {
  try {
    process.kill(pid, 'SIGKILL');
    logger.info('RECOVERY', `Killed stale subprocess PID ${pid} from session ${sessionDbId}`);
  } catch {
    // ESRCH = no such process (already dead)
  }
  dbManager.getSessionStore().clearSubprocessPid(sessionDbId);
}
```

### 7. Tests

- Update `tests/sdk-agent-resume.test.ts`: verify `queryRef` is set during session start
- Update session mock factories in affected test files to include optional `queryRef`
- Add unit test for `getStalePids()` and `clearSubprocessPid()` in SessionStore tests
- Add unit test for stale PID cleanup logic

## Files

| File | Change |
|------|--------|
| `src/services/worker-types.ts` | Add `queryRef?: Query` to `ActiveSession` |
| `src/services/worker/SDKAgent.ts` | Store `queryResult` on `session.queryRef`, pass PID callback |
| `src/services/worker/SessionManager.ts` | Call `close()` + `clearSubprocessPid()` in `deleteSession()` |
| `src/services/worker/ProcessRegistry.ts` | Add `onPidCaptured` callback to `createPidCapturingSpawn()` |
| `src/services/sqlite/SessionStore.ts` | Add migration + `updateSubprocessPid`/`clearSubprocessPid`/`getStalePids` |
| `src/services/worker-service.ts` | Add stale PID cleanup in `initializeBackground()` |
| `tests/sdk-agent-resume.test.ts` | Add queryRef test |
| `tests/sqlite/` or relevant test files | Add SessionStore PID methods tests |

## Verification

1. `npx tsc --noEmit` -- zero type errors
2. `npm run build` -- clean build
3. `npm test` -- all unit tests pass
4. `npm run test:sdk` -- all 3 integration tests pass
5. Full suite: 82 files, 1613+ tests, 0 regressions

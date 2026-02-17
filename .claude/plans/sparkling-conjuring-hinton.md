# Async PostToolUse Observations with Health Reporting

## Context

PostToolUse hooks run synchronously, blocking Claude after every tool call (~500ms overhead: Node startup + health check + HTTP POST + response wait). When the worker is unhealthy (503), this blocks Claude with errors that it can't act on mid-tool-use. Yesterday's outage showed 503 errors flooding every PostToolUse, degrading the session.

**Goal**: Fire-and-forget observations at PostToolUse. Report observation health at UserPromptSubmit (the natural checkpoint where Claude can act on it).

## Changes

### 1. `src/cli/handlers/observation.ts` — Fire-and-forget HTTP POST

Replace `await fetch()` with `http.request()` fire-and-forget:

```typescript
import http from 'http';

const req = http.request({ hostname: '127.0.0.1', port, path: '/api/sessions/observations', method: 'POST', headers: { 'Content-Type': 'application/json' } });
req.on('error', () => {}); // Silently ignore
req.write(JSON.stringify(body));
req.end();

// Wait for TCP write flush only (not response) — ~1ms on localhost
await new Promise<void>(resolve => {
  req.on('finish', resolve);
  req.on('error', resolve);
  setTimeout(resolve, 100); // Safety cap
});
```

- Keep `ensureWorkerRunning()` health check (quick, ~50ms) — if unhealthy, track failure and skip
- Track failures in `~/.magic-claude-mem/.obs-health` (JSON: `{ failures: N, lastError: string, since: ISO }`)
- On successful fire, reset the failure counter

### 2. `plugin/hooks/hooks.json` — Remove `start` from PostToolUse

Before:
```json
"PostToolUse": [
  { "command": "worker-service.cjs start", "timeout": 60 },
  { "command": "worker-service.cjs hook claude-code observation", "timeout": 120 }
]
```

After:
```json
"PostToolUse": [
  { "command": "worker-service.cjs hook claude-code observation", "timeout": 30 }
]
```

The observation handler already calls `ensureWorkerRunning()` which does a quick health check. The separate `start` step is redundant and adds ~200ms per tool call. Reduced timeout since fire-and-forget should complete in <200ms.

### 3. `src/cli/handlers/session-init.ts` — Report observation health

At the start of `execute()`, after `ensureWorkerRunning()`:

- Read `~/.magic-claude-mem/.obs-health`
- If `failures > 0`, add warning via existing `hookSpecificOutput` pattern (same as `workerNotReadyResult()`)
- Clear the file after reading

Message to Claude:
```
⚠️ claude-mem: {N} observations failed to store since last prompt. Memory capture may be incomplete. If this persists, try restarting the worker with: magic-claude-mem worker:restart
```

### 4. `src/cli/observation-health.ts` — Shared health file utilities (new)

Small utility module (~30 lines):

```typescript
export function recordObservationFailure(error: string): void
export function recordObservationSuccess(): void
export function readAndClearObservationHealth(): { failures: number; lastError: string; since: string } | null
```

- File path: `~/.magic-claude-mem/.obs-health`
- JSON format: `{ failures: number, lastError: string, since: string }`
- `recordObservationSuccess()` deletes the file (reset on any success)
- `readAndClearObservationHealth()` reads and deletes atomically

## Files

| File | Change |
|------|--------|
| `src/cli/handlers/observation.ts` | Fire-and-forget HTTP, track failures |
| `src/cli/observation-health.ts` | **New** — shared health file read/write |
| `src/cli/handlers/session-init.ts` | Read health file, report via hookSpecificOutput |
| `plugin/hooks/hooks.json` | Remove `start` from PostToolUse, reduce timeout |

## Sync impact

**No sync script changes needed.** The new `observation-health.ts` is TypeScript source bundled by esbuild into `worker-service.cjs`. The `hooks.json` lives under `plugin/hooks/` which is already synced to marketplace and cache.

## Why this approach

- **No worker changes**: Health tracking is hook-side (temp file), not worker-side
- **Reuses existing pattern**: `hookSpecificOutput` with `additionalContext` — same as `workerNotReadyResult()`
- **Self-healing**: Any successful observation clears the failure counter
- **Minimal overhead**: `http.request()` + `finish` event is ~1-5ms on localhost vs ~300ms for full fetch round-trip

## Verification

1. Start a session, use tools — observations should fire without blocking
2. Stop the worker (`magic-claude-mem worker:stop`), use tools — observations silently fail
3. Send next prompt — UserPromptSubmit should show observation health warning
4. Restart worker — next successful observation clears the warning
5. Measure timing: `time node worker-service.cjs hook claude-code observation` should be <200ms vs current ~500ms

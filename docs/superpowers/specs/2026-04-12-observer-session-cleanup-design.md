# Observer Session JSONL Cleanup — Design Spec

**Date**: 2026-04-12  
**Status**: Approved

## Problem

claude-mem spawns background "observer" agents via the Claude Agent SDK. Each observer session uses `~/.claude-mem/observer-sessions` as its `cwd`, so Claude Code accumulates raw conversation transcripts (`.jsonl`) under:

```
~/.claude/projects/-Users-<username>--claude-mem-observer-sessions/
```

These files are never cleaned up automatically. In practice, individual sessions grew to 9GB+ and the total directory reached 85GB — wasting disk space with no value, since the useful data (observations) is already extracted into SQLite.

## Goals

- Automatically delete stale or oversized observer session JSONL files
- Integrate cleanly into the existing `CleanupJob` scheduled cleanup mechanism
- Safe defaults: enabled by default, no dry-run required (observer sessions are always expendable)

## Non-Goals

- Cleaning up primary (user-facing) Claude Code sessions
- Cleaning up the SQLite database entries (already handled by existing CleanupJob steps)

## Design

### Where: `CleanupJob.ts`

No new files. All changes live inside `src/services/worker/CleanupJob.ts`.

### Config (`CleanupConfig`)

Three new fields added to the existing interface and defaults:

```typescript
// Observer session JSONL cleanup
enableObserverSessionCleanup: boolean;   // default: true
observerSessionMaxAgeDays: number;       // default: 30  — delete if mtime > this
observerSessionMaxSizeMB: number;        // default: 500 — delete if size > this (MB)
```

### Result (`CleanupResult`)

New section added to the result object:

```typescript
observerSessionCleanup: {
  enabled: boolean;
  deleted: number;       // number of files (+ dirs) removed
  freedBytes: number;    // total bytes freed
}
```

### Logic (`runObserverSessionCleanup()`)

1. Derive the Claude projects directory for observer sessions:
   - Take `OBSERVER_SESSIONS_DIR` (e.g. `/Users/foo/.claude-mem/observer-sessions`)
   - Replace each `/` with `-` to get the project dir name (e.g. `-Users-foo--claude-mem-observer-sessions`)
   - Full path: `CLAUDE_CONFIG_DIR/projects/<derived-name>/`

2. If directory does not exist, return early (nothing to clean).

3. Scan for `.jsonl` files. For each file, delete if **either** condition is true:
   - **Age**: `Date.now() - mtime > observerSessionMaxAgeDays * 86400 * 1000`
   - **Size**: `fileSize > observerSessionMaxSizeMB * 1024 * 1024`

4. For each deleted `.jsonl`, also delete the matching same-name subdirectory if it exists (Claude Code sometimes creates these alongside JSONL files).

5. Accumulate `deleted` count and `freedBytes`, log at INFO level.

### Integration into `run()`

Add as Step 4 (after existing three steps), following the same pattern:

```typescript
if (this.config.enableObserverSessionCleanup) {
  const obsResult = await this.runObserverSessionCleanup();
  result.observerSessionCleanup = { enabled: true, ...obsResult };
}
```

### `getStats()` update

Include `observerSessionCleanup` config fields in the returned stats object so the API surface remains consistent.

## Deletion Criteria Summary

| Condition | Threshold | Delete? |
|-----------|-----------|---------|
| File age  | > 30 days | Yes (OR) |
| File size | > 500 MB  | Yes (OR) |
| Neither   | —         | Keep |

Both thresholds are configurable via `CleanupConfig` / `settings.json`.

## Safety

- Observer sessions are **always** expendable — useful data is already in SQLite
- No dry-run needed for this step (unlike memory cleanup which defaults to dry-run)
- Only targets the isolated observer sessions project dir, not any other Claude project
- Errors are caught per-file; one failure does not abort the whole cleanup

## Files Changed

- `src/services/worker/CleanupJob.ts` — only file modified

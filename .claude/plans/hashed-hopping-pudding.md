# Fix: Project name not updating on session resume

## Context

When a user resumes a Claude Code session (`--resume`), `createSDKSession()` uses `INSERT OR IGNORE` — the `project` field is set on first insert and **never updated**. All subsequent prompts in the same session keep the original project, even when `cwd` changes. Since `session.project` propagates to every observation via `ResponseProcessor` and all three agents (SDK, Gemini, OpenAI-compat), all observations get tagged to the stale project.

An in-memory refresh already exists in `SessionManager.ts:67-78` that reads `sdk_sessions.project` from DB and updates the cached session. But since the DB is never updated, this refresh is a no-op.

## Risk Analysis

- **Multi-directory cd**: Session project flips on each new prompt. This is correct behavior — observations from the current directory should be tagged to the current project. Already-stored observations keep their own `project` field.
- **Empty project overwrite**: `handleObservationsByClaudeId` calls `createSDKSession(contentSessionId, '', '')`. Guard with `if (project)` prevents empty overwrites.
- **In-memory cache**: Already handled by `SessionManager.ts:67-78` — once DB is updated, in-memory session picks it up on next `initializeSession()` call.

## Changes

### 1. `src/services/sqlite/sessions/create.ts` — Update project on existing sessions

After `INSERT OR IGNORE`, add conditional `UPDATE`:

```typescript
if (project) {
  db.prepare('UPDATE sdk_sessions SET project = ? WHERE content_session_id = ?')
    .run(project, contentSessionId);
}
```

This fires only from `handleSessionInitByClaudeId` (UserPromptSubmit hook), where `project` is always non-empty. Observation/summarize handlers pass `''`, so the guard prevents overwrites.

### 2. `src/cli/handlers/user-message.ts:19` — Minor consistency fix

Replace `basename(input.cwd)` with `getProjectName(input.cwd)` for edge case handling.

### 3. Tests — `tests/sqlite/session-project-update.test.ts` (new)

1. Session created with project "cloud", re-init with same → stays "cloud"
2. Session created with empty project (race), then init with "cloud" → updated to "cloud"
3. Session created with "sr-renovate", re-init with "cloud" → updated to "cloud"
4. Session created with "cloud", observation handler calls with empty → stays "cloud"

## Verification

1. `npm test` — all ~1700 tests pass
2. `npm run build` — build succeeds
3. Manual: resume a session, verify `/api/sessions/:id/status` shows correct project

# Fix: Pin Node Binary to Prevent nvs Version Conflicts

## Context

The worker daemon (Express on port 37777) uses `better-sqlite3`, a native Node addon compiled against a specific Node ABI version. The user uses **nvs** to switch Node versions between projects (e.g., Node 24 for project A, Node 20 for project B).

Currently, `smart-install.js` detects Node version changes and rebuilds native modules for the new version. This causes a tug-of-war: Session A compiles for Node 24, Session B recompiles for Node 20, making the running worker's loaded module incompatible on restart. The auto-rebuild catch block added in the previous session is a band-aid that should be reverted.

**Root cause**: `spawnDaemon()` uses `process.execPath` (the current session's Node binary), and `smart-install.js` rebuilds on every Node version change.

**Fix**: Pin the Node binary at install time. The worker always starts with the binary that compiled its native modules. Stop rebuilding when only the Node version changes.

## Changes

### 1. `scripts/smart-install.js` — Pin execPath, stop rebuilding on Node change

- Add `execPath: process.execPath` to the marker file
- Remove `getNodeVersion() !== marker.node` from `needsInstall()` — don't rebuild just because Node changed
- Add check: if `marker.execPath` is missing or the binary no longer exists on disk → reinstall
- Keep `node: getNodeVersion()` in marker for diagnostics

### 2. `src/services/infrastructure/ProcessManager.ts` — Use pinned binary

- Add `getWorkerNodeBinary()`: reads marker file, returns stored `execPath` if it exists on disk, falls back to `process.execPath`
- Update `spawnDaemon()` line 291 (Windows) and line 325 (Unix) to use `getWorkerNodeBinary()` instead of `process.execPath`
- Add `nodeVersion: string` to `PidInfo` interface for diagnostics

### 3. `src/services/worker-service.ts` — Revert auto-rebuild, guard in-process path

- **Revert** the try/catch auto-rebuild block (lines 287-300) → plain `this.dbManager.initialize()`
- **Guard** the in-process hook start (line 702-716): if `process.execPath !== getWorkerNodeBinary()`, skip in-process start and fall through to `spawnDaemon()` via `ensureWorkerStarted()`
- Add `nodeVersion: process.version` to `writePidFile()` call

### 4. Build and deploy

- Run `npm run build-and-sync`
- Bump version, commit, push

## Files

| File | Change |
|------|--------|
| `scripts/smart-install.js` | Remove Node version trigger, add execPath to marker |
| `src/services/infrastructure/ProcessManager.ts` | Add `getWorkerNodeBinary()`, update `spawnDaemon()`, extend `PidInfo` |
| `src/services/worker-service.ts` | Revert auto-rebuild, guard in-process path, record nodeVersion in PID |

## Why NOT rebuild on Node version change

With the pinned binary, the worker always starts with the Node that compiled its modules. Different Claude Code sessions (different Node versions) interact with the worker via HTTP only — no native module dependency. Rebuilding on Node change creates a tug-of-war between sessions and breaks the running worker.

Reinstall triggers (kept): plugin version change, missing node_modules, missing marker, deleted pinned binary.

## Verification

1. Check marker file after install: `cat ~/.claude/plugins/marketplaces/magic-claude-mem/.install-version` — should contain `execPath`
2. Start Claude Code in a project with a different Node version — worker should NOT rebuild, should use pinned binary
3. Check PID file: `cat ~/.magic-claude-mem/worker.pid` — should contain `nodeVersion`
4. Worker health: `curl http://127.0.0.1:37777/health` — should return 200

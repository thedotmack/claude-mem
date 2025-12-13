# ADR 0001: Replace PM2 with Native Bun Process Management

**Status:** ACCEPTED

**Date:** 2025-12-13

**Deciders:** thedotmack, claude

## Context

Claude-Mem previously used PM2 as an external process manager for the worker service, which was launched via `execSync` from TypeScript hooks. This introduced several operational challenges:

1. **External Dependency**: PM2 requires separate installation and management (`npm install -g pm2`)
2. **Platform Complexity**: PM2 behaves differently across Windows, macOS, and Linux, requiring platform-specific workarounds
3. **Process Tracking**: PID files and PM2 daemon state could become inconsistent, especially after system crashes or updates
4. **Native Compilation**: No native dependencies, but PM2 adds operational overhead
5. **Auto-installation**: Users had to manually install PM2; new installations often failed silently

The worker service is already written in TypeScript/Bun with no PM2-specific dependencies—PM2 was merely wrapping Bun process invocations.

## Decision

Replace PM2 with a custom Bun-based ProcessManager that:

1. **Manages worker as a child process** - Uses Bun's native subprocess APIs
2. **Tracks via PID file** - Simple, platform-agnostic `~/.claude-mem/worker.pid` tracking
3. **Auto-starts via `spawnSync`** - No daemon required; worker starts on-demand from hooks
4. **Auto-cleans legacy PM2** - Migrates existing installations in background
5. **Integrates with Bun CLI** - Use `bun run worker:*` commands consistently

## Implementation

### New Architecture

```
Hook → Worker CLI → Check PID file → Start if missing → HTTP call
```

**Components:**

- `src/services/worker/ProcessManager.ts` - Handles start/stop/status via PID file
- `plugin/scripts/worker-cli.js` - Bun CLI wrapper for `bun run worker:start|stop|restart|status`
- `src/services/worker/LegacyCleanup.ts` - Auto-cleanup of PM2 processes on first run

### Database Driver Change

Also migrated `better-sqlite3` npm package → `bun:sqlite` runtime module:
- Zero native compilation required
- Same API compatibility
- Shipped with Bun runtime

### Build Commands

Changed all documentation and scripts from npm to bun:
```bash
# Before
npm run build && npm run worker:start

# After  
bun run build && bun run worker:start
```

## Consequences

### Positive

- ✅ **Reduced external dependencies** - One fewer npm global package
- ✅ **Simpler process tracking** - Single PID file vs PM2 daemon complexity
- ✅ **Better auto-installation** - Bun auto-installs if missing via `--bun` engine requirement
- ✅ **Cross-platform consistency** - Same code path on all OS
- ✅ **Faster startup** - No daemon overhead, direct subprocess spawning
- ✅ **Easier debugging** - Direct worker logs without PM2 redirection
- ✅ **Unified toolchain** - Bun for runtime, build, and process management

### Negative

- ⚠️ **Manual PID cleanup required** - If process crashes without cleanup, PID file persists (mitigated by auto-cleanup on startup)
- ⚠️ **Less mature than PM2** - PM2 has 10+ years of battle-testing for edge cases
- ⚠️ **No built-in clustering** - Not needed for current use case but would require custom implementation

### Neutral

- Worker service must be running for hooks to function (unchanged; hooks already required it)
- Monitoring/metrics tools must directly poll `/api/health` instead of PM2 daemon

## Alternatives Considered

1. **Keep PM2** - Rejected due to operational overhead and installation friction
2. **Use systemd/launchd directly** - Too OS-specific; Bun solution more portable
3. **Node.js child_process + custom daemon** - Unnecessary complexity; Bun runtime already provides subprocess APIs
4. **Switch to different process manager (supervisor, systemd)** - Adds operational complexity without Bun integration benefits

## Related Documents

- [PM2-TO-BUN-MIGRATION.md](../PM2-TO-BUN-MIGRATION.md) - Technical migration guide
- [ProcessManager.ts](../../src/services/worker/ProcessManager.ts) - Implementation
- [v7.1.0 CHANGELOG](../../CHANGELOG.md#710---2025-12-13) - Release notes

## References

- Bun Documentation: https://bun.sh
- ADR Format: https://adr.github.io
- Original PM2 Discussion: Issue tracking process manager selection

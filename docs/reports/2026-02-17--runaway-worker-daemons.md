# Runaway Worker Daemon Processes

**Date**: 2026-02-17 11:21 PM EST
**Branch**: `bugfix/security-hardening`
**Version**: 10.2.5

## Snapshot

At time of investigation, the following claude-mem processes were running:

| PID | Type | Source | CPU % | CPU Time | RAM |
|-----|------|--------|-------|----------|-----|
| 56381 | Chroma server | marketplace | 51.6% | 51m 35s | 438 MB |
| 89623 | Worker daemon | marketplace | 17.4% | 94m 35s | 183 MB |
| 93024 | Worker daemon | marketplace | 0.0% | 18m 58s | 38 MB |
| 98418 | Worker daemon | marketplace | 0.0% | 6m 17s | 92 MB |
| 97100 | Worker daemon | cache/10.2.4 | 18.6% | 7m 46s | 236 MB |
| 97276 | Worker daemon | cache/10.2.4 | 0.5% | 7m 34s | 525 MB |
| 97454 | Worker daemon | cache/10.2.4 | 0.0% | 6m 52s | 56 MB |
| 97628 | Worker daemon | cache/10.2.4 | 0.1% | 6m 39s | 71 MB |
| 97948 | Worker daemon | cache/10.2.4 | 10.2% | 6m 31s | 89 MB |
| 98099 | Worker daemon | cache/10.2.4 | 0.1% | 6m 31s | 406 MB |
| 98163 | Worker daemon | cache/10.2.4 | 20.7% | 6m 5s | 963 MB |

**Total**: 10 worker daemons, 1 Chroma server, 7 MCP servers

## What Happened

Each Claude Code session spawned its own worker daemon instead of detecting and reusing an existing one. The result was 10 concurrent worker daemons competing for:

- **CPU**: Combined ~67% sustained CPU across workers alone
- **RAM**: ~2.6 GB across worker daemons, plus 438 MB for Chroma
- **SQLite locks**: Multiple writers contending on `claude-mem.db`, likely causing the "readonly database" errors observed in Chroma backfill logs

The 7 `cache/10.2.4` workers all spawned within a ~1 minute window (11:20-11:21 PM), suggesting multiple Claude Code sessions started near-simultaneously and each triggered a worker spawn.

## Root Cause Analysis

The worker daemon spawn logic checks if a worker is already running before starting a new one. There are two failure modes:

1. **Race condition on startup**: Multiple sessions start within seconds. Each checks for a running worker, finds none (or the health check times out), and spawns its own. No file-based lock or PID file prevents this.

2. **Marketplace vs cache path divergence**: Workers spawned from `~/.claude/plugins/marketplaces/thedotmack/` and `~/.claude/plugins/cache/thedotmack/claude-mem/10.2.4/` are treated as separate daemons because their script paths differ. The deduplication logic likely compares process command lines or PID files scoped to the install path.

## Related

- `docs/reports/issue-603-worker-daemon-leaks-child-processes.md` — Previously documented worker leak issue
- `#51154` — "Chroma Backfill Failing with Readonly Database Error" — likely caused by SQLite write contention from multiple workers

## Resolution

Killed 9 of 10 worker daemons, keeping only PID 98418 (newest marketplace worker). Chroma server (PID 56381) left running as it was legitimately performing backfill.

## Recommendations

1. **PID file with advisory lock**: Use a single `~/.claude-mem/worker.pid` file with `flock` or equivalent to prevent concurrent daemon spawns regardless of install path.
2. **Unify daemon identity**: The worker should identify itself by the port it binds (37777), not by its script path. If port 37777 is already bound, don't spawn.
3. **Startup health check with retry**: Before spawning, check `localhost:37777/health` with a short retry (e.g., 3 attempts over 2 seconds) to handle the race window where a worker is starting but not yet listening.

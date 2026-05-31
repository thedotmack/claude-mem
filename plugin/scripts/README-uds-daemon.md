# UDS Daemon Pipeline (Sprint 1 + 2)

Optional bundled performance-and-reliability layer for claude-mem hook events.
Replaces the per-hook Bun cold-start with a long-lived UNIX-socket singleton —
hook latency drops from ~467 ms p50 to ~60 ms p50 (≈7.8×).

## Files

| File | Purpose |
|------|---------|
| `daemon-server.mjs` | Persistent Bun process listening on UNIX socket, receives NDJSON hook events, writes to SQLite. |
| `hook-client.mjs` | Thin per-hook client: fast-skip filter for non-interesting tools + auto-spawn of daemon. |
| `plugin-hook-perf-patch.v2.mjs` | Idempotent patcher for `hooks/hooks.json` and `hooks/codex-hooks.json` (rewrites to use the new client, with `.uds-bak` rollback). |
| `setup-tree-sitter.mjs` | Installs tree-sitter parsers so `smart_search` / `smart_outline` / `smart_unfold` work. |
| `settings-doctor.mjs` | Audits `~/.claude-mem/settings.json` for security / noise / dead-config issues. |
| `install.sh` | One-shot installer applying the patcher + setup-tree-sitter. Includes `--rollback`. |
| `lib/constants.mjs` | Shared `INTERESTING_TOOLS`, regex, prefix constants. |
| `lib/paths.mjs` | Shared `DATA_DIR`, `DEFAULT_SOCK`, `DEFAULT_LOCK`, `DB_PATH`, `SETTINGS_PATH`. |
| `lib/importance.mjs` | Heuristic observation-importance scorer (0..1) + ADR auto-pin matcher. |
| `cli/memory-bank-export.mjs` | Exports observations to Cline 4-file Markdown convention. |
| `mcp-sidecar/` | Tiny MCP server exposing 4 Resources + 3 Prompts (requires `bun install` inside the directory). |

## Activation

```bash
bash plugin/scripts/install.sh         # applies patcher to live hooks.json + sets up tree-sitter
bash plugin/scripts/install.sh --rollback   # restores .uds-bak files
```

## Reliability invariants

- **Drain-await:** `hook-client` uses callback-based `socket.write` so the kernel flush completes before exit (no fire-and-forget frame loss).
- **RPC ack:** daemon replies `{ok, queued}` per insert; client awaits the reply (200 ms timeout) before closing — protects against socket-FIN-before-data races.
- **UTF-8:** daemon uses `node:string_decoder` instead of `chunk.toString()` so multi-byte codepoints split across reads don't corrupt JSON.
- **FK-safe inserts:** daemon resolves or inserts the `sdk_sessions` row before writing `pending_messages` (`session_db_id=0` sentinel would 100% silent-fail under `PRAGMA foreign_keys=ON`).
- **O_EXCL lock:** prevents concurrent hook-clients from spawning multiple daemons; stale-takeover via PID-aliveness check.

## Tests

```bash
bun test tests/uds-daemon/     # 38/38 green
```

## Rollback

`install.sh --rollback` plus the `.uds-bak` files next to the live `hooks.json`
restore the original behavior. The patcher never edits the bundled source.

# Lessons Learned — Multi-Node Network Mode

**Date**: 2026-03-24
**Branch**: feat/multi-machine-network

---

## Bun Networking in Daemons

### Problem
Bun's `fetch()` loses outbound network connectivity after a few calls inside `setInterval` when running as a background daemon on some macOS machines (confirmed on MBPM4M). The first 2-3 calls succeed, then all subsequent calls fail with "Unable to connect" or "Was there a typo in the url or port?".

### Root Cause
**SSH session isolation on macOS.** Daemons launched via SSH background (`nohup bun ... &`) lose network access. The same code launched from a local terminal (GUI session, RustDesk, or console) works perfectly. This is a macOS security feature that restricts network extensions for SSH-spawned background processes.

### Additional Factor
Express.js `async` handlers with `fetch()` inside further corrupt Bun's networking. `app.all('*', async handler)` and `app.use(async handler)` both cause issues. Non-async handlers with `.then()` chains are more stable but still fail in SSH context.

### Solution
1. **ProxyServer rewritten with `http.createServer`** — no Express dependency. Raw Node `http.request()` for all outbound calls.
2. **Proxy must be launched from a local terminal** or via **launchd** (which runs in the user's login session, not SSH).
3. **Bundle size dropped from 1.9MB (Express) to 26KB** — lighter is more stable.

### Not the Cause
- Bun version (tested 1.3.8 → 1.3.11, same behavior)
- macOS Firewall (tested enabled/disabled, same behavior)
- DNS resolution (tested hostname, .local, Thunderbolt IP, LAN IP)
- CJS vs TS format (both fail in SSH context)

---

## macOS Firewall Differences

| Machine | Firewall | Impact |
|---------|----------|--------|
| MSM3U | Enabled | Bun authorized, no issues (local terminal) |
| MSM4M | Disabled | No issues |
| MBPM4M | Enabled | Bun authorized but SSH daemons still fail |

The firewall controls **incoming** connections only. The outbound fetch failure is caused by SSH session isolation, not the firewall.

---

## Database Transfer Between Machines

### Problem
Copying `claude-mem.db` via `scp` between machines causes "database disk image is malformed" errors.

### Root Cause
SQLite WAL mode leaves `.db-wal` and `.db-shm` files that must be transferred together, or the WAL must be checkpointed first.

### Solution
```bash
# 1. Stop the worker on source
# 2. Checkpoint WAL
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA wal_checkpoint(TRUNCATE)"
# 3. Verify integrity
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check"
# 4. Delete WAL/SHM on destination BEFORE copying
ssh TARGET "rm -f ~/.claude-mem/claude-mem.db-wal ~/.claude-mem/claude-mem.db-shm"
# 5. Copy
scp ~/.claude-mem/claude-mem.db TARGET:~/.claude-mem/
# 6. Set WAL mode on destination
ssh TARGET "sqlite3 ~/.claude-mem/claude-mem.db 'PRAGMA journal_mode=WAL'"
```

---

## Launchd for Headless Server

### Problem
The worker on MSM3U runs headless. The launchd plist must include `PATH` and `HOME` environment variables, otherwise `node`, `bun`, and `claude` CLI are invisible.

### Solution
LaunchdManager generates plist with:
```xml
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:~/.bun/bin:~/.local/bin</string>
<key>HOME</key><string>/Users/regis</string>
```

### Claude Code Auth
The SDK Agent on the server needs `claude auth login` to have been done from a GUI session. The macOS Keychain is only accessible from the login session (console, Screen Sharing, RustDesk). SSH sessions cannot access it.

---

## Platform vs Node vs Instance

### Design
- **Node** = physical machine (`os.hostname()`) — property of the machine
- **Platform** = which tool made the request (`claude-code`, `cursor`, `raw`) — property of the request
- **Instance** = which specific session/agent (`contentSessionId`, `openclaw-legal`) — property of the session

### Key Insight
A single node can run multiple platforms simultaneously (Claude Code + OpenClaw + curl). The proxy does NOT declare the platform — it's a transparent forwarder. Only the hook or the caller knows the platform.

### Data Flow
```
body.platform (hook adapter, most authoritative)
  > X-Claude-Mem-Platform header (curl/API user sets their own)
    > null (unknown — honest)
```

---

## Tailscale/Network Resolution

DNS resolution handles transport selection automatically:
- **Thunderbolt** (169.254.x.x) — link-local, preferred by macOS when cable connected
- **Bonjour** (.local) — local network mDNS
- **Tailscale MagicDNS** — remote, encrypted mesh
- **hostname.lan** — router DNS

No hardcoded IPs needed. Use `os.hostname()` or the setting `CLAUDE_MEM_SERVER_HOST` with the machine hostname.

---

## Migration System Gotchas

claude-mem has **two parallel migration systems**:
1. `migrations/runner.ts` (MigrationRunner) — authoritative for ClaudeMemDatabase
2. `SessionStore.ts` — inline migrations in the constructor

**Both must be updated** for any schema change. The SessionStore is used directly by the worker and manages its own migrations independently.

---

## Viewer/Settings in Client Mode

The viewer on a client node accesses the API via the local proxy (localhost:37777). The proxy must serve **local** settings (not forward to server) so the Settings panel shows the client's config, not the server's.

The proxy intercepts `GET/PUT /api/settings` locally.

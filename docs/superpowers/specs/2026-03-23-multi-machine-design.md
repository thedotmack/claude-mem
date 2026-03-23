# Multi-Machine Network Mode for claude-mem

**Date**: 2026-03-23
**Author**: Regis
**Status**: Draft
**Version**: 1.1.0
**Base**: claude-mem v10.6.2 (fork Regis-RCR/claude-mem)

---

## 1. Problem

Each Mac runs its own claude-mem instance with its own DB. Observations, sessions, and context accumulated on one machine are invisible from the others. Knowledge is fragmented.

## 2. Goal

Share a single claude-mem instance across multiple Macs:
- One DB, one source of truth
- Zero ID conflicts (no merge/consolidation)
- Transparent operation for Claude Code on every machine
- Offline resilience with automatic replay on reconnection
- Security: unauthenticated remote requests rejected in all modes

## 3. Target Topology

```
MSM3U (Server — always on)
  Worker :37777 + DB + Chroma
  launchd auto-start
       ▲              ▲
       │ TB/Bonjour   │ TB/Tailscale/WireGuard
       │              │
MSM4M (Client)    MBPM4M (Client)
  Proxy :37777      Proxy :37777
  Buffer JSONL      Buffer JSONL
```

DNS resolution handles transport selection automatically:
- Thunderbolt → link-local route preferred by macOS
- Bonjour (.local) → local network
- Tailscale MagicDNS → remote encrypted mesh
- WireGuard via Firewalla → backup

## 4. Architecture

### 4.1 Three Network Modes

| Mode | Behavior |
|------|----------|
| `standalone` | Current behavior unchanged. Default. |
| `server` | Local worker + accepts remote connections + logs clients + launchd autostart |
| `client` | HTTP proxy on localhost:37777 → forwards to remote server + offline buffer |

### 4.2 Configuration

New settings in `~/.claude-mem/settings.json`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `CLAUDE_MEM_NETWORK_MODE` | `standalone\|server\|client` | `standalone` | Network mode |
| `CLAUDE_MEM_SERVER_HOST` | string | `""` | Server hostname (required in client mode) |
| `CLAUDE_MEM_SERVER_PORT` | string | `"37777"` | Server port if different from local |
| `CLAUDE_MEM_NODE_NAME` | string | `""` | Machine identity. Fallback: env `CLAUDE_MEM_NODE_NAME`, then `os.hostname()` |
| `CLAUDE_MEM_INSTANCE_NAME` | string | `""` | Instance identity (e.g., `openclaw-legal`). Nullable. |
| `CLAUDE_MEM_AUTH_TOKEN` | string | `""` | Shared secret for remote auth. Auto-generated on first server start if empty. |

All settings can be overridden by environment variables of the same name.

**Naming note**: `CLAUDE_MEM_NETWORK_MODE` is distinct from the existing `CLAUDE_MEM_MODE` (which controls feature profiles like 'code'). The prefix `NETWORK_` disambiguates. A comment in `SettingsDefaultsManager` must clarify this distinction.

### 4.3 Node Identity

Single source function used everywhere:

```typescript
// src/shared/node-identity.ts
export function getNodeName(): string {
  return process.env.CLAUDE_MEM_NODE_NAME
    || settings.CLAUDE_MEM_NODE_NAME
    || os.hostname();
}
```

The same function is used by the proxy (for the header), the server (for local fallback), and the buffer (for provenance). This guarantees the same machine always produces the same `node` value regardless of code path.

## 5. Proxy Client

### 5.1 ProxyServer

**New file**: `src/services/proxy/ProxyServer.ts` (~220 lines)

An Express server that listens on `127.0.0.1:37777` and forwards all requests to `${serverHost}:${serverPort}`.

- Adds headers to every forwarded request:
  - `X-Claude-Mem-Node: <getNodeName()>`
  - `X-Claude-Mem-Instance: <getInstanceName()>`
  - `X-Claude-Mem-Mode: proxy`
  - `Authorization: Bearer <authToken>`
- Mutating requests (POST) that fail due to transport error → buffered (Section 6)
- Read requests (GET) that fail → return 503 with explicit error
- Background health check every 10s on the server
- When server comes back → trigger buffer replay

### 5.2 Integration into Worker Startup

In `worker-service.ts` → `main()` → `case 'start'`:

```
if (CLAUDE_MEM_NETWORK_MODE === 'client') {
  // Verify server is reachable (with timeout)
  // Start ProxyServer on localhost:37777
  // Write PID file (hooks see a live process, never double-spawn)
  // Exit 0
}
// ... existing standalone/server logic
```

### 5.3 MCP Transparency

The MCP server (`plugin/.mcp.json`) is spawned by Claude Code independently. It calls `workerHttpRequest()` → `localhost:37777`. In client mode, this hits the proxy. The proxy forwards with auth. **Zero modification to the MCP server.** This is the correct architecture because:

- MCP server has no knowledge of network topology
- All network logic (auth, fallback, buffer) is in one place: the proxy
- MCP works identically across all three modes
- The 0.5ms localhost hop is invisible vs 1-50ms network

## 6. Offline Buffer

### 6.1 Two-Layer Architecture

```
Hook
  │ workerHttpRequest() → localhost:37777
  ▼
ProxyServer (layer 1)
  ├─ server reachable → forward → OK
  └─ server down → buffer in JSONL + return 202
       │
       └─ proxy also down? (layer 2)
           workerHttpRequest() catches transport error
           → buffer in same JSONL + return fake OK
```

Layer 1 (proxy) is the normal path. Layer 2 is a **separate wrapper function** `bufferedPostRequest()` used only by POST hook handlers — NOT added to `workerHttpRequest()` itself, which remains a pure HTTP utility. This avoids polluting the shared function with file I/O and changing its return contract for all callers (GET, MCP, etc.).

### 6.2 Buffer Format

**File**: `~/.claude-mem/buffer.jsonl` — append-only, no rotation, no purge.

```jsonl
{"ts":"2026-03-23T12:00:00Z","method":"POST","path":"/api/sessions/observations","body":{...},"node":"macstudio-m4max-regis"}
```

### 6.3 Replay

- Triggered when proxy detects server is reachable again (health check)
- Sequential FIFO replay
- Each successfully replayed line is removed (atomic rewrite: write tmp → rename)
- On failure → stop replay, retry next cycle
- **Idempotent**: Sessions have `contentSessionId` uniqueness (UNIQUE constraint). Observations have `content_hash` for deduplication, but note: the dedup window is 30 seconds (`created_at_epoch > timestampEpoch - 30000`). For replayed entries after hours offline, the original timestamps will be outside this window. To handle this, replay sets a `replayed: true` flag in the request, and the server uses a wider dedup window (or skips the time check) for flagged requests.
- **Serialization**: Buffer writes (append) and replay (read + rewrite) must be serialized. Since the proxy is the sole owner of the buffer file, this is guaranteed by the single-process model. Layer 2 (`bufferedPostRequest`) appends only — no read/rewrite — so no race with the proxy.
- **No size cap, no data loss**: buffer grows while server is down. Warning logged if >10MB. Purge only after successful replay.

### 6.4 What Gets Buffered

| Request type | Buffered? | Reason |
|-------------|-----------|--------|
| POST /api/sessions/observations | Yes | Observation data must not be lost |
| POST /api/sessions/init | Yes | Session must be created |
| POST /api/sessions/summarize | Yes | Summary must be generated |
| GET /api/context/inject | No | Stale read has no value |
| GET /api/search | No | Read-only |
| GET /api/health | No | Diagnostic only |

## 7. Security

### 7.1 Bearer Token Authentication

**New middleware** in `middleware.ts`, active in ALL modes (not just server):

```typescript
import { timingSafeEqual } from 'crypto';

function requireAuth(req, res, next) {
  if (isLocalhost(req)) return next();

  const expectedToken = settings.CLAUDE_MEM_AUTH_TOKEN;
  if (!expectedToken) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Remote access requires CLAUDE_MEM_AUTH_TOKEN'
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.slice(7);

  // Timing-safe comparison to prevent timing attacks
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expectedToken);
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
```

### 7.2 Behavior by Mode

| Mode | Token configured | Localhost request | Remote request |
|------|-----------------|-------------------|----------------|
| standalone | no (default) | OK | **403 rejected** |
| standalone | yes | OK | OK with valid token |
| server | yes (required) | OK | OK with valid token |
| client | n/a | OK (proxy is local) | n/a |

### 7.3 Security Improvement for Existing Users

This is a security fix independent of multi-machine:
> Previously, when `CLAUDE_MEM_WORKER_HOST` was `0.0.0.0`, all endpoints were accessible from the network without authentication. This change rejects unauthenticated non-localhost requests in all modes.

### 7.4 Server Mode Enforcement

On first `start` in server mode:
1. If `CLAUDE_MEM_AUTH_TOKEN` is empty → auto-generate 32-byte hex token, write to settings.json, log with copy instructions
2. If `CLAUDE_MEM_WORKER_HOST` is `127.0.0.1` → change to `0.0.0.0` with informational log
3. Server mode without token → **refuse to start** with clear error message

## 8. Server Awareness

### 8.1 Client Tracking

New middleware extracts headers from proxied requests:

```typescript
if (req.headers['x-claude-mem-node']) {
  clientRegistry.touch(
    req.headers['x-claude-mem-node'],
    req.ip,
    req.headers['x-claude-mem-mode'],
    req.headers['x-claude-mem-instance']
  );
}
```

`ClientRegistry` is an in-memory `Map<string, ClientInfo>` (volatile, not persisted):

```typescript
interface ClientInfo {
  node: string;
  ip: string;
  mode: string;       // 'proxy' | 'direct'
  instance: string;   // nullable
  firstSeen: string;
  lastSeen: string;
  requestCount: number;
}
```

### 8.2 New Endpoints

- **`GET /api/clients`** — returns connected client list. Protected by `requireAuth` (global middleware) — remote requests need a valid token. No additional `requireLocalhost` since proxies authenticate via Bearer token.
- **`GET /api/health`** — enriched with `mode`, `connectedClients`, `node` fields.

## 9. Provenance

### 9.1 Three Dimensions

| Column | Meaning | Example | Source |
|--------|---------|---------|--------|
| `node` | Which machine | `macstudio-m4max-regis` | `getNodeName()` via header or local fallback |
| `platform` | Which tool | `claude-code`, `cursor`, `raw` | `input.platform` from hooks |
| `instance` | Which specific instance | `openclaw-legal`, `null` | Setting or header |

These are orthogonal:
- `node` + `platform` = where + by what
- `instance` = which specific agent (when multiple on same node+platform)

### 9.2 Database Migration

**Target**: `src/services/sqlite/migrations/runner.ts` (MigrationRunner) + mirror in `SessionStore.ts`. The legacy `migrations.ts` (versions 1-7) is NOT the target. Current latest migration is version 23 (`custom_title`).

```sql
-- Migration version 24: Add provenance columns
ALTER TABLE observations ADD COLUMN node TEXT;
ALTER TABLE observations ADD COLUMN platform TEXT;
ALTER TABLE observations ADD COLUMN instance TEXT;
ALTER TABLE sdk_sessions ADD COLUMN node TEXT;
ALTER TABLE sdk_sessions ADD COLUMN platform TEXT;
ALTER TABLE sdk_sessions ADD COLUMN instance TEXT;
CREATE INDEX idx_observations_node ON observations(node);
```

All nullable. Existing observations get `NULL` (pre-multi-machine, backward-compatible).

**Note on `platform`**: Currently `platform` exists in hook processing (`input.platform` in `NormalizedHookInput`) but is **never sent in HTTP request bodies** to the worker. The observation handler (`observation.ts`) sends `contentSessionId, tool_name, tool_input, tool_response, cwd` — no `platform`. To store `platform`, each hook handler (session-init, observation, summarize, session-complete) must add `platform` to their POST bodies, and `SessionRoutes` must extract and pass it through. This is additional work beyond the header-based `node`/`instance` injection.

### 9.3 Injection Flow

1. Hook sends observation via POST to localhost:37777
2. In client mode: proxy adds `X-Claude-Mem-Node`, `X-Claude-Mem-Instance` headers
3. Server middleware extracts headers
4. `SessionRoutes` passes `node`, `platform`, `instance` to `storeObservation()`. Note: `storeObservation()` signature (in `observations/store.ts` and `transactions.ts`) must be extended to accept these fields. The INSERT SQL must include the new columns.
5. In standalone mode: no header → `getNodeName()` for local fallback
6. `platform` is injected differently: hook handlers add it to POST body (not via header), server extracts from body

## 10. Dashboard and Context

### 10.1 Dynamic Dashboard URL

In `src/cli/handlers/context.ts`:

```typescript
function getDashboardUrl(port: number): string {
  const mode = settings.CLAUDE_MEM_NETWORK_MODE;
  if (mode === 'client') {
    return `http://${settings.CLAUDE_MEM_SERVER_HOST}:${settings.CLAUDE_MEM_SERVER_PORT || port}`;
  }
  if (mode === 'server') {
    // Return only the URL — the "remote also available" annotation
    // is handled separately in the systemMessage display layer
    return `http://localhost:${port}`;
  }
  return `http://localhost:${port}`;
}
```

### 10.2 Context Header Enrichment

```
Mode: server | Node: macstudio-m3ultra-regis | Clients: MSM4M, MBPM4M
```
Or in client mode:
```
Mode: client → macstudio-m3ultra-regis | Node: macstudio-m4max-regis | Buffer: 0 pending
```

### 10.3 Viewer UI Improvements

- **Header**: version badge, network mode badge, connected clients count
- **ObservationCard**: node provenance badge (hidden in standalone if all NULL)
- **Logs streaming**: network events (client_connected, client_disconnected, buffer_replay, auth_rejected) appear in the SSE feed as system cards

## 11. Server Deployment — launchd

### 11.1 Idempotent Auto-Setup

**New file**: `src/services/infrastructure/LaunchdManager.ts` (~80 lines)

`ensureLaunchdService()` runs at every `worker-service.cjs start` in server mode on macOS:

| Situation | Action |
|-----------|--------|
| Plist absent | Generate + `launchctl load` |
| Plist identical, service not loaded | `launchctl load` |
| Plist outdated (port/path changed) | `launchctl unload` + rewrite + `launchctl load` |
| Plist identical, service loaded | No-op |
| Mode changed from server to standalone | `launchctl unload` + delete plist |

**Plist**: `~/Library/LaunchAgents/com.claude-mem.worker.plist`
- `RunAtLoad: true` — starts at login (headless, no Claude Code session needed)
- `KeepAlive: true` — auto-restart on crash
- Logs to `~/.claude-mem/logs/worker-{stdout,stderr}.log`

### 11.2 Belt and Suspenders

- **launchd**: ensures worker is running at boot and after crashes
- **SessionStart hook**: still runs `worker-service.cjs start`. If worker is already healthy → exit 0 (idempotent). If launchd crashed → relaunches daemon.

### 11.3 Windows Compatibility

`ensureLaunchdService()` is guarded by `process.platform === 'darwin'`. The `start` command logic must not hardcode launchd — the autostart call is a conditional platform check. Windows continues using the existing `CLAUDE_MEM_MANAGED` + IPC wrapper mechanism. Windows Service/Task Scheduler support is in the v2 backlog.

## 12. SSE Log Events

New events broadcast through `SSEBroadcaster` for the viewer:

| Event | When | Data |
|-------|------|------|
| `client_connected` | New node seen for the first time | `{ node, ip }` |
| `client_heartbeat` | Health check received from client | `{ node, requestCount }` |
| `client_disconnected` | No request from node in >60s | `{ node, lastSeen }` |
| `buffer_replay` | Buffer replay in progress | `{ node, replayed, remaining }` |
| `auth_rejected` | Request without/bad token | `{ ip, path }` |

## 13. Files Changed

### New Files (5)

| File | Purpose | Lines |
|------|---------|-------|
| `src/services/proxy/ProxyServer.ts` | HTTP proxy + buffer layer 1 | ~220 |
| `src/shared/node-identity.ts` | `getNodeName()`, `getInstanceName()` | ~30 |
| `src/services/infrastructure/LaunchdManager.ts` | Idempotent plist management | ~80 |
| `src/services/infrastructure/OfflineBuffer.ts` | JSONL buffer + replay | ~120 |
| `src/services/server/ClientRegistry.ts` | In-memory client tracking | ~50 |

### Modified Files (15)

| File | Changes | Lines |
|------|---------|-------|
| `src/services/worker-service.ts` | Mode routing in `main()` + launchd call | ~50 |
| `src/shared/SettingsDefaultsManager.ts` | 6 new settings + interface | ~15 |
| `src/shared/worker-utils.ts` | `bufferedPostRequest()` wrapper (layer 2) | ~30 |
| `src/services/server/Server.ts` | `/api/clients`, enriched `/api/health` | ~40 |
| `src/services/worker/http/middleware.ts` | Auth middleware + client-tracking + CORS `allowedHeaders` update for `X-Claude-Mem-*` | ~45 |
| `src/services/sqlite/migrations/runner.ts` | Migration version 24 (node, platform, instance) | ~15 |
| `src/services/sqlite/SessionStore.ts` | Mirror migration 24 | ~15 |
| `src/services/sqlite/observations/store.ts` | Extend `storeObservation()` signature + INSERT SQL | ~15 |
| `src/services/sqlite/observations/transactions.ts` | Extend batch store variants | ~10 |
| `src/services/worker/http/routes/SessionRoutes.ts` | Extract headers, pass to stores | ~25 |
| `src/cli/handlers/observation.ts` | Add `platform` to POST body | ~5 |
| `src/cli/handlers/session-init.ts` | Add `platform` to POST body | ~5 |
| `src/cli/handlers/context.ts` | Dynamic dashboard URL | ~15 |
| `src/ui/viewer/components/Header.tsx` | Version + mode + clients badge | ~25 |
| `src/ui/viewer/components/ObservationCard.tsx` | Node provenance badge | ~10 |
| `src/services/worker/SSEBroadcaster.ts` | Network events | ~20 |

**Total: ~860 lines, 5 new files, 16 modified files**

## 14. Backlog v2

- [ ] Dual-DB mode with full reconciliation (offline option B)
- [ ] Windows Service / Task Scheduler for server mode
- [ ] Buffer threshold alert in session context ("X observations pending sync")
- [ ] Node filter dropdown in viewer
- [ ] Network monitoring dashboard (proxy→server latency, uptime)
- [ ] Chroma/vector sync in multi-machine mode
- [ ] Instance support in viewer (filter, badge)
- [ ] `platform` storage — currently used in hook processing but not persisted. Store when there's a consumer beyond provenance display.

## 15. Migration Path

1. **Existing users**: `standalone` is the default. Nothing changes. The auth middleware rejects remote requests that were previously unprotected (security improvement).
2. **Server setup**: Change `CLAUDE_MEM_NETWORK_MODE` to `server` in settings.json. First `start` auto-generates auth token and configures launchd.
3. **Client setup**: Set `CLAUDE_MEM_NETWORK_MODE` to `client`, `CLAUDE_MEM_SERVER_HOST` to the server hostname, copy the auth token from the server's settings.json.
4. **Database**: Migration 024 adds nullable columns. Existing observations keep `NULL` provenance. New observations get full provenance.

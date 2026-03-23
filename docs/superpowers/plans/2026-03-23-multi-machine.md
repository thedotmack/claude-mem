# Multi-Machine Network Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable claude-mem to share a single worker+DB across multiple Macs via a transparent HTTP proxy, with offline buffering, provenance tracking, and security hardening.

**Architecture:** Three network modes (standalone/server/client) configured via settings.json. Client machines run a local proxy that forwards to the remote server. All modes get Bearer token auth on non-localhost requests. Observations gain `node`/`platform`/`instance` provenance columns. A JSONL buffer handles offline resilience.

**Tech Stack:** TypeScript, Express, SQLite (bun:sqlite), Bun runtime, launchd (macOS), crypto (timingSafeEqual)

**Spec:** `docs/superpowers/specs/2026-03-23-multi-machine-design.md` v1.1.0

---

## Phase 1: Foundation (no behavior change, all modes still standalone)

### Task 1: Settings — Add network mode configuration

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Test: `tests/shared/settings-defaults-manager.test.ts` (add to existing file)

- [ ] **Step 1: Write failing test for new settings**

```typescript
// Add to existing tests/shared/settings-defaults-manager.test.ts
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager';

describe('Network mode settings', () => {
  it('should have standalone as default CLAUDE_MEM_NETWORK_MODE', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_NETWORK_MODE')).toBe('standalone');
  });

  it('should have empty default for CLAUDE_MEM_SERVER_HOST', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_HOST')).toBe('');
  });

  it('should have 37777 as default CLAUDE_MEM_SERVER_PORT', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_PORT')).toBe('37777');
  });

  it('should have empty default for CLAUDE_MEM_NODE_NAME', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_NODE_NAME')).toBe('');
  });

  it('should have empty default for CLAUDE_MEM_INSTANCE_NAME', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_INSTANCE_NAME')).toBe('');
  });

  it('should have empty default for CLAUDE_MEM_AUTH_TOKEN', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_AUTH_TOKEN')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/regis/Development/GitHub/thedotmack/claude-mem && bun test tests/shared/settings-defaults.test.ts`
Expected: FAIL — properties don't exist on `SettingsDefaults`

- [ ] **Step 3: Add settings to SettingsDefaultsManager**

In `src/shared/SettingsDefaultsManager.ts`, add to `SettingsDefaults` interface:

```typescript
// Network Mode Configuration
// NOTE: CLAUDE_MEM_NETWORK_MODE controls multi-machine networking (standalone/server/client).
// This is distinct from CLAUDE_MEM_MODE which controls feature profiles (code/local/etc).
CLAUDE_MEM_NETWORK_MODE: string;
CLAUDE_MEM_SERVER_HOST: string;
CLAUDE_MEM_SERVER_PORT: string;
CLAUDE_MEM_NODE_NAME: string;
CLAUDE_MEM_INSTANCE_NAME: string;
CLAUDE_MEM_AUTH_TOKEN: string;
```

And to `DEFAULTS`:

```typescript
CLAUDE_MEM_NETWORK_MODE: 'standalone',
CLAUDE_MEM_SERVER_HOST: '',
CLAUDE_MEM_SERVER_PORT: '37777',
CLAUDE_MEM_NODE_NAME: '',
CLAUDE_MEM_INSTANCE_NAME: '',
CLAUDE_MEM_AUTH_TOKEN: '',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/shared/settings-defaults.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts tests/shared/settings-defaults.test.ts
git commit -m "feat: add network mode settings to SettingsDefaultsManager"
```

---

### Task 2: Node Identity — getNodeName() and getInstanceName()

**Files:**
- Create: `src/shared/node-identity.ts`
- Test: `tests/shared/node-identity.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/shared/node-identity.test.ts
import { hostname } from 'os';

describe('getNodeName', () => {
  const originalEnv = process.env.CLAUDE_MEM_NODE_NAME;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_MEM_NODE_NAME;
    else process.env.CLAUDE_MEM_NODE_NAME = originalEnv;
  });

  it('should return env var when set', async () => {
    process.env.CLAUDE_MEM_NODE_NAME = 'test-node';
    const { getNodeName } = await import('../../src/shared/node-identity');
    expect(getNodeName()).toBe('test-node');
  });

  it('should fallback to os.hostname() when no env or setting', async () => {
    delete process.env.CLAUDE_MEM_NODE_NAME;
    const { getNodeName } = await import('../../src/shared/node-identity');
    const name = getNodeName();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});

describe('getInstanceName', () => {
  it('should return empty string by default', async () => {
    const { getInstanceName } = await import('../../src/shared/node-identity');
    expect(getInstanceName()).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/shared/node-identity.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement node-identity.ts**

```typescript
// src/shared/node-identity.ts
import { hostname } from 'os';
import path from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';

export function getNodeName(): string {
  if (process.env.CLAUDE_MEM_NODE_NAME) return process.env.CLAUDE_MEM_NODE_NAME;

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  if (settings.CLAUDE_MEM_NODE_NAME) return settings.CLAUDE_MEM_NODE_NAME;

  return hostname();
}

export function getInstanceName(): string {
  if (process.env.CLAUDE_MEM_INSTANCE_NAME) return process.env.CLAUDE_MEM_INSTANCE_NAME;

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_INSTANCE_NAME || '';
}

export function getNetworkMode(): 'standalone' | 'server' | 'client' {
  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const mode = settings.CLAUDE_MEM_NETWORK_MODE;
  if (mode === 'server' || mode === 'client') return mode;
  return 'standalone';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/shared/node-identity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/node-identity.ts tests/shared/node-identity.test.ts
git commit -m "feat: add node identity module (getNodeName, getInstanceName, getNetworkMode)"
```

---

### Task 3: Database Migration 24 — Provenance columns

**Files:**
- Modify: `src/services/sqlite/SessionStore.ts` (inline migration)
- Test: `tests/sqlite/migration-24-provenance.test.ts`

**Reference:** Check current latest migration version in `SessionStore.ts` (expected: version 23 = `custom_title`). Search for `version: 23` to find the right location.

- [ ] **Step 1: Write failing test**

```typescript
// tests/sqlite/migration-24-provenance.test.ts
import { Database } from 'bun:sqlite';

describe('Migration 24: provenance columns', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
  });

  afterEach(() => db.close());

  it('should add node, platform, instance columns to observations', () => {
    db.run('ALTER TABLE observations ADD COLUMN node TEXT');
    db.run('ALTER TABLE observations ADD COLUMN platform TEXT');
    db.run('ALTER TABLE observations ADD COLUMN instance TEXT');

    const info = db.query('PRAGMA table_info(observations)').all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain('node');
    expect(colNames).toContain('platform');
    expect(colNames).toContain('instance');
  });

  it('should allow NULL values for provenance columns', () => {
    db.run('ALTER TABLE observations ADD COLUMN node TEXT');
    db.run(`INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch) VALUES ('test', 'test', 'discovery', '2026-01-01', 1735689600000)`);
    const row = db.query('SELECT node FROM observations WHERE memory_session_id = ?').get('test') as any;
    expect(row.node).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (this is a schema test, not a migration runner test)**

Run: `bun test tests/sqlite/migration-24-provenance.test.ts`
Expected: PASS (we're testing the SQL, not the migration runner yet)

- [ ] **Step 3: Add migration 24 to MigrationRunner**

**IMPORTANT**: The migration runner (`src/services/sqlite/migrations/runner.ts`) is the authoritative location. Each migration is a private method. `SessionStore.ts` delegates to MigrationRunner.

Add a new private method in `MigrationRunner`:

```typescript
private addProvenanceColumns(): void {
  const currentVersion = this.getVersion();
  if (currentVersion >= 24) return;

  // Check if columns already exist (idempotent)
  const obsInfo = this.db.query('PRAGMA table_info(observations)').all() as any[];
  const hasNode = obsInfo.some((c: any) => c.name === 'node');
  if (!hasNode) {
    this.db.run('ALTER TABLE observations ADD COLUMN node TEXT');
    this.db.run('ALTER TABLE observations ADD COLUMN platform TEXT');
    this.db.run('ALTER TABLE observations ADD COLUMN instance TEXT');
    this.db.run('ALTER TABLE sdk_sessions ADD COLUMN node TEXT');
    this.db.run('ALTER TABLE sdk_sessions ADD COLUMN platform TEXT');
    this.db.run('ALTER TABLE sdk_sessions ADD COLUMN instance TEXT');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_node ON observations(node)');
  }

  this.setVersion(24);
}
```

Add the call `this.addProvenanceColumns()` at the end of `runAllMigrations()`.

- [ ] **Step 4: Run existing test suite to verify no regressions**

Run: `bun test tests/sqlite/`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/sqlite/SessionStore.ts src/services/sqlite/migrations/runner.ts tests/sqlite/migration-24-provenance.test.ts
git commit -m "feat: add migration 24 — provenance columns (node, platform, instance)"
```

---

## Phase 2: Security (standalone improvement, no network features yet)

### Task 4: Auth Middleware — requireAuth

**Files:**
- Modify: `src/services/worker/http/middleware.ts`
- Test: `tests/server/auth-middleware.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/server/auth-middleware.test.ts
import express from 'express';
import request from 'supertest';

describe('requireAuth middleware', () => {
  // Tests will use a test Express app with the middleware applied
  // We need to mock settings to control CLAUDE_MEM_AUTH_TOKEN

  it('should allow localhost requests without token', async () => {
    // localhost request → 200
  });

  it('should reject remote requests when no token configured', async () => {
    // non-localhost request, no CLAUDE_MEM_AUTH_TOKEN → 403
  });

  it('should reject remote requests with wrong token', async () => {
    // non-localhost request, wrong Bearer token → 401
  });

  it('should allow remote requests with correct token', async () => {
    // non-localhost request, correct Bearer token → 200
  });

  it('should reject malformed Authorization header', async () => {
    // "Basic xxx" instead of "Bearer xxx" → 401
  });

  it('should use timing-safe comparison', async () => {
    // Verify crypto.timingSafeEqual is used (structural test)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/auth-middleware.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement requireAuth in middleware.ts**

Add to `src/services/worker/http/middleware.ts`:

```typescript
import { timingSafeEqual } from 'crypto';

export function createAuthMiddleware(getAuthToken: () => string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Localhost bypass
    const clientIp = req.ip || req.connection.remoteAddress || '';
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1'
      || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
    if (isLocal) return next();

    const expectedToken = getAuthToken();
    if (!expectedToken) {
      logger.warn('SECURITY', 'Remote request rejected — no auth token configured', { ip: clientIp, path: req.path });
      res.status(403).json({ error: 'forbidden', message: 'Remote access requires CLAUDE_MEM_AUTH_TOKEN' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      logger.warn('SECURITY', 'Unauthorized request — missing or malformed token', { ip: clientIp, path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = authHeader.slice(7);

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      logger.warn('SECURITY', 'Unauthorized request — invalid token', { ip: clientIp, path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
```

Add to `createMiddleware()` function — insert the auth middleware early in the array. Also update CORS `allowedHeaders` to include `X-Claude-Mem-Node`, `X-Claude-Mem-Instance`, `X-Claude-Mem-Mode`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/auth-middleware.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All PASS — standalone mode unaffected (all requests are localhost)

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/http/middleware.ts tests/server/auth-middleware.test.ts
git commit -m "feat: add Bearer token auth middleware — rejects unauthenticated remote requests in all modes

Security improvement independent of multi-machine: previously, binding to
0.0.0.0 exposed all endpoints without authentication."
```

---

## Phase 3: Server Mode

### Task 5: Server awareness — ClientRegistry + /api/clients

**Files:**
- Create: `src/services/server/ClientRegistry.ts`
- Modify: `src/services/server/Server.ts`
- Modify: `src/services/worker/http/middleware.ts` (client-tracking)
- Test: `tests/server/client-registry.test.ts`

- [ ] **Step 1: Write failing test for ClientRegistry**

```typescript
// tests/server/client-registry.test.ts
describe('ClientRegistry', () => {
  it('should track a new client on touch()', () => {});
  it('should increment requestCount on repeated touch()', () => {});
  it('should mark client disconnected after timeout', () => {});
  it('should return all clients via getClients()', () => {});
  it('should return client count via getClientCount()', () => {});
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement ClientRegistry**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Add client-tracking middleware to middleware.ts (extracts X-Claude-Mem-Node header)**
- [ ] **Step 6: Add GET /api/clients and enrich GET /api/health in Server.ts**
- [ ] **Step 7: Run full test suite**
- [ ] **Step 8: Commit**

```bash
git commit -m "feat: add server awareness — ClientRegistry, /api/clients endpoint, enriched /api/health"
```

---

### Task 6: LaunchdManager — idempotent plist management

**Files:**
- Create: `src/services/infrastructure/LaunchdManager.ts`
- Test: `tests/infrastructure/launchd-manager.test.ts`

- [ ] **Step 1: Write failing test**

Test `generatePlist()`, `isServiceLoaded()` (mocked), `ensureLaunchdService()` idempotent behavior.

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement LaunchdManager**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add LaunchdManager — idempotent plist generation and launchctl management"
```

---

### Task 7: Server mode startup — worker-service.ts integration

**Files:**
- Modify: `src/services/worker-service.ts`
- Test: `tests/worker-service-modes.test.ts`

- [ ] **Step 1: Write failing test for server mode startup**

Test that when `CLAUDE_MEM_NETWORK_MODE=server`:
- Auth token is auto-generated if empty
- `CLAUDE_MEM_WORKER_HOST` is changed to `0.0.0.0` if `127.0.0.1`
- `ensureLaunchdService()` is called on macOS
- Worker refuses to start without token

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Modify main() in worker-service.ts**

In `case 'start'`, before existing logic, add server mode checks:

```typescript
const networkMode = getNetworkMode();
if (networkMode === 'server') {
  await ensureServerModeReady(settings); // auto-gen token, fix bind, launchd
}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run full test suite**
- [ ] **Step 6: Commit**

```bash
git commit -m "feat: server mode startup — auto-token, bind 0.0.0.0, launchd integration"
```

---

## Phase 4: Provenance Injection

### Task 8: Hook handlers — add platform to POST bodies

**Files:**
- Modify: `src/cli/handlers/observation.ts`
- Modify: `src/cli/handlers/session-init.ts`
- Modify: `src/cli/handlers/summarize.ts` (if exists, find via grep)
- Modify: `src/cli/handlers/session-complete.ts` (if exists, find via grep)
- Test: (use existing hook tests)

- [ ] **Step 1: Find all hook handlers that POST to the worker**

Run: `grep -rn "workerHttpRequest\|fetch.*37777" src/cli/handlers/`
Identify all files that send POST bodies to the worker.

- [ ] **Step 2: Add `platform: input.platform` to each POST body**

In each handler found in Step 1 (observation.ts, session-init.ts, summarize.ts, session-complete.ts), add `platform: input.platform` to the JSON body sent to the worker. The `input.platform` field is already populated by `hook-command.ts` line 81.

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: inject platform into all hook POST bodies for provenance tracking"
```

---

### Task 9: Server-side provenance extraction + storage

**Files:**
- Modify: `src/services/worker/http/routes/SessionRoutes.ts`
- Modify: `src/services/sqlite/observations/store.ts`
- Modify: `src/services/sqlite/transactions.ts` (top-level, NOT under observations/)
- Test: `tests/sqlite/observation-provenance.test.ts`

- [ ] **Step 1: Write failing test**

Test that `storeObservation()` with `node`, `platform`, `instance` params writes them to DB.

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Extend storeObservation() signature and SQL**
- [ ] **Step 4: Extract provenance from request headers/body in SessionRoutes**

In SessionRoutes, for each observation/session handler:
```typescript
const node = req.headers['x-claude-mem-node'] as string || getNodeName();
const platform = req.body.platform || null;
const instance = req.headers['x-claude-mem-instance'] as string || null;
```

- [ ] **Step 5: Run test to verify it passes**
- [ ] **Step 6: Run full test suite**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat: store provenance (node, platform, instance) in observations and sessions"
```

---

## Phase 5: Client Mode — Proxy + Buffer

### Task 10: OfflineBuffer — JSONL append + replay

**Files:**
- Create: `src/services/infrastructure/OfflineBuffer.ts`
- Test: `tests/infrastructure/offline-buffer.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `append()`, `replay()` with mock HTTP, atomic rewrite, idempotent replay, serialization.

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement OfflineBuffer**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add OfflineBuffer — JSONL append + sequential FIFO replay"
```

---

### Task 11: ProxyServer — HTTP forwarding + buffer integration

**Files:**
- Create: `src/services/proxy/ProxyServer.ts`
- Test: `tests/proxy/proxy-server.test.ts`

- [ ] **Step 1: Write failing tests**

Test: forward GET, forward POST, add auth/node headers, buffer on transport error, replay on health recovery, return 503 for GET failures, return 202 for buffered POST.

- [ ] **Step 2: Run test to verify they fail**
- [ ] **Step 3: Implement ProxyServer**
- [ ] **Step 4: Run test to verify they pass**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add ProxyServer — HTTP forwarding with auth headers and offline buffering"
```

---

### Task 12: Client mode startup — worker-service.ts integration

**Files:**
- Modify: `src/services/worker-service.ts`
- Modify: `src/shared/worker-utils.ts` (bufferedPostRequest wrapper)
- Test: `tests/worker-service-client-mode.test.ts`

- [ ] **Step 1: Write failing test**

Test that when `CLAUDE_MEM_NETWORK_MODE=client`:
- ProxyServer is started instead of WorkerService
- PID file is written
- `CLAUDE_MEM_SERVER_HOST` must be set (error if empty)

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Add client mode branch in main()**

```typescript
if (networkMode === 'client') {
  const serverHost = settings.CLAUDE_MEM_SERVER_HOST;
  if (!serverHost) {
    logger.error('SYSTEM', 'Client mode requires CLAUDE_MEM_SERVER_HOST');
    process.exit(1);
  }
  // Start proxy daemon, write PID, exit
}
```

- [ ] **Step 4: Add bufferedPostRequest() to worker-utils.ts (layer 2 safety net)**
- [ ] **Step 5: Run test to verify it passes**
- [ ] **Step 6: Run full test suite**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat: client mode startup — proxy instead of worker, bufferedPostRequest layer 2"
```

---

## Phase 6: Dashboard + Context

### Task 13: Dynamic dashboard URL in context.ts

**Files:**
- Modify: `src/cli/handlers/context.ts`
- Test: (manual verification — the context output is text)

- [ ] **Step 1: Add getDashboardUrl() function**
- [ ] **Step 2: Replace hardcoded localhost URL at line 71**
- [ ] **Step 3: Enrich context header with network metadata**

In the `systemMessage` construction, add mode/node/buffer info per spec Section 10.2:
- Server mode: `Mode: server | Node: <name> | Clients: <list>`
- Client mode: `Mode: client → <server> | Node: <name> | Buffer: <N> pending`
- Standalone mode: no change

This requires calling `/api/health` (enriched in Task 5) or `/api/clients` to get client count, or reading buffer file size for pending count.

- [ ] **Step 4: Run full test suite**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: dynamic dashboard URL and context header enrichment based on network mode"
```

---

### Task 14: Viewer UI — version badge + node provenance

**Files:**
- Modify: `src/ui/viewer/components/Header.tsx`
- Modify: `src/ui/viewer/components/ObservationCard.tsx`

- [ ] **Step 1: Add version + mode badge to Header.tsx**

Use existing `/api/stats` (has `worker.version`) and enriched `/api/health` (has `mode`, `connectedClients`).

- [ ] **Step 2: Add node provenance badge to ObservationCard.tsx**

Show `node` if not null and network mode is not standalone.

- [ ] **Step 3: Build viewer and verify visually**

Run: `npm run build`
Open: `http://localhost:37777`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: viewer UI — version/mode badges, node provenance on observations"
```

---

### Task 15: SSE network events

**Files:**
- Modify: `src/services/worker/SSEBroadcaster.ts`
- Modify: `src/services/server/ClientRegistry.ts` (emit events)

- [ ] **Step 1: Add network event types to SSEBroadcaster** (client_connected, client_heartbeat, client_disconnected, buffer_replay, auth_rejected)
- [ ] **Step 2: Emit client_connected/client_heartbeat/client_disconnected from ClientRegistry** (heartbeat on repeated touch, disconnected via a 60s timeout check interval)
- [ ] **Step 3: Emit buffer_replay from ProxyServer when replay triggers**
- [ ] **Step 4: Emit auth_rejected from auth middleware**
- [ ] **Step 4: Run full test suite**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: SSE network events — client connect/disconnect, auth rejected"
```

---

## Phase 7: Integration Testing

### Task 16: End-to-end integration test

**Files:**
- Create: `tests/integration/multi-machine-e2e.test.ts`

- [ ] **Step 1: Write E2E test**

Spin up a server worker on a random port, spin up a proxy pointing to it, send observations through the proxy, verify they appear in the server's DB with correct `node` provenance.

- [ ] **Step 2: Write offline buffer E2E test**

Start proxy with no server, send observations (→ buffered), start server, wait for replay, verify observations arrive.

- [ ] **Step 3: Write auth rejection E2E test**

Start server with token, send request without token from non-localhost → 401.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "test: multi-machine E2E integration tests"
```

---

## Phase 8: Build + Documentation

### Task 17: Build and verify

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 2: Sync to marketplace (local)**

Run: `npm run build-and-sync`

- [ ] **Step 3: Manual smoke test in standalone mode**

Start a Claude Code session. Verify context injection works, observations are stored, viewer is accessible. No regressions.

- [ ] **Step 4: Commit any build fixes**

---

### Task 18: Update CLAUDE.md

- [ ] **Step 1: Add network mode documentation to CLAUDE.md**

Add a section about the three modes, configuration, and security.

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add multi-machine network mode documentation to CLAUDE.md"
```

---

## Task Dependency Graph

```
Task 1 (Settings) ──┐
Task 2 (Node ID) ───┤
Task 3 (Migration) ─┴──► Task 4 (Auth) ──► Task 5 (ClientRegistry) ──► Task 7 (Server startup)
                                                                          │
                    Task 6 (Launchd) ─────────────────────────────────────┘
                                                                          │
                    Task 8 (Hook platform) ──► Task 9 (Provenance store) ─┘
                                                                          │
                    Task 10 (Buffer) ──► Task 11 (Proxy) ──► Task 12 (Client startup)
                                                                          │
                    Task 13 (Dashboard URL) ─┐                            │
                    Task 14 (Viewer UI) ─────┤                            │
                    Task 15 (SSE events) ────┴──► Task 16 (E2E) ──► Task 17 (Build) ──► Task 18 (Docs)
```

Phases 1-2 can be merged to `main` independently as a standalone security improvement.
Phase 3 (server mode) can be tested independently on one machine.
Phases 4-5 complete the multi-machine feature.
Phases 6-8 are polish and validation.

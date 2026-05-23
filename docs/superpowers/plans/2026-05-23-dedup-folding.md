# Dedup Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse identical tool observations within a 30s sliding window before they reach the SDK, cutting redundant Claude round-trips while preserving repetition count metadata.

**Architecture:** Insert a `shouldFold` decision step inside `SessionManager.queueObservation`, backed by a new `pending_messages.fold_key` column + 5s-cached config. Folded entries bump `fold_count` on the existing row instead of enqueueing a new SDK turn. `buildObservationPrompt` reads `fold_count` and emits a `<repetition>` hint when > 1. Opt-in via `CLAUDE_MEM_DEDUP_FOLD_ENABLED=false` default.

**Tech Stack:** TypeScript, bun:test, SQLite (bun:sqlite), Node `crypto`, existing claude-mem worker/SDK pipeline.

**Reference:** See `docs/superpowers/specs/2026-05-23-dedup-folding-design.md` for the full design.

---

### Task 1: Core fold-key computation

**Files:**
- Create: `src/services/worker/dedup-fold.ts`
- Test: `tests/services/worker/dedup-fold.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/worker/dedup-fold.test.ts
import { describe, it, expect } from 'bun:test';
import { computeFoldKey } from '../../../src/services/worker/dedup-fold.js';

describe('computeFoldKey', () => {
  it('returns a 16-char hex string', () => {
    const key = computeFoldKey({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across runs (snapshot)', () => {
    const key = computeFoldKey({
      tool_name: 'Bash',
      tool_input: { command: 'ls /foo' },
      cwd: '/repo',
      agent_id: 'main',
    });
    // Locked snapshot — regenerate only if algorithm intentionally changes
    expect(key).toBe('a93b48c7a96fa9a4');
  });

  it('treats reordered object keys as identical (canonical sort)', () => {
    const a = computeFoldKey({ tool_name: 'Edit', tool_input: { file: 'x', mode: 'a' } });
    const b = computeFoldKey({ tool_name: 'Edit', tool_input: { mode: 'a', file: 'x' } });
    expect(a).toBe(b);
  });

  it('produces different keys for different cwd', () => {
    const a = computeFoldKey({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/a' });
    const b = computeFoldKey({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/b' });
    expect(a).not.toBe(b);
  });

  it('produces different keys for different agent_id', () => {
    const a = computeFoldKey({ tool_name: 'Bash', tool_input: {}, agent_id: 'main' });
    const b = computeFoldKey({ tool_name: 'Bash', tool_input: {}, agent_id: 'sub-1' });
    expect(a).not.toBe(b);
  });

  it('handles missing cwd and agent_id as empty strings', () => {
    const a = computeFoldKey({ tool_name: 'Bash', tool_input: {} });
    const b = computeFoldKey({ tool_name: 'Bash', tool_input: {}, cwd: '', agent_id: '' });
    expect(a).toBe(b);
  });

  it('preserves array order inside tool_input', () => {
    const a = computeFoldKey({ tool_name: 'X', tool_input: { args: ['a', 'b'] } });
    const b = computeFoldKey({ tool_name: 'X', tool_input: { args: ['b', 'a'] } });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liguanchen/Desktop/lgc/claude-mem && bun test tests/services/worker/dedup-fold.test.ts`

Expected: FAIL with "Cannot find module" — `dedup-fold.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/worker/dedup-fold.ts
import { createHash } from 'crypto';

export interface FoldKeyInput {
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  agent_id?: string;
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

export function computeFoldKey(input: FoldKeyInput): string {
  const canonical = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: sortObjectKeys(input.tool_input),
    cwd: input.cwd ?? '',
    agent_id: input.agent_id ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run test — snapshot will mismatch initially**

Run: `bun test tests/services/worker/dedup-fold.test.ts`

Expected: 6 pass, 1 fail on the snapshot. Read the actual hex from the test output and update the snapshot in the test file:

```ts
expect(key).toBe('<paste the actual hex from the failure output>');
```

Then re-run; expected: all 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/dedup-fold.ts tests/services/worker/dedup-fold.test.ts
git commit -m "feat(dedup-fold): add computeFoldKey with canonical-sort hashing"
```

---

### Task 2: Settings keys + logger component

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `src/utils/logger.ts`
- Test: extend `tests/services/worker/dedup-fold.test.ts` (later in Task 3)

- [ ] **Step 1: Read current SettingsDefaultsManager defaults**

Run: `grep -n "CLAUDE_MEM_REDACT" /Users/liguanchen/Desktop/lgc/claude-mem/src/shared/SettingsDefaultsManager.ts`

Use this as the placement reference. The three new keys go in the same block (sibling group).

- [ ] **Step 2: Add three flat keys to SettingsDefaultsManager**

In `src/shared/SettingsDefaultsManager.ts`, in the defaults object (next to the redaction keys), add:

```ts
CLAUDE_MEM_DEDUP_FOLD_ENABLED: 'false',
CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '30',
CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS: '',
```

If the file declares a TypeScript interface for `Settings`, add the same three keys as `string` typed fields.

- [ ] **Step 3: Add 'DEDUP' to logger Component union**

In `src/utils/logger.ts`, locate the `Component` union type and add `'DEDUP'` in alphabetic order. For example, if the union currently looks like:

```ts
export type Component = 'CONTEXT' | 'HTTP' | 'QUEUE' | 'REDACT' | 'SDK' | ...;
```

Insert `'DEDUP'` between `'CONTEXT'` and `'HTTP'`:

```ts
export type Component = 'CONTEXT' | 'DEDUP' | 'HTTP' | 'QUEUE' | 'REDACT' | 'SDK' | ...;
```

If the file has any switch/dispatch over Component values, add the `DEDUP` case there too (read the file before editing).

- [ ] **Step 4: Compile check**

Run: `cd /Users/liguanchen/Desktop/lgc/claude-mem && bunx tsc --noEmit 2>&1 | head -30`

Expected: no new errors. Pre-existing errors in unrelated files are OK; just verify nothing in `SettingsDefaultsManager.ts` or `logger.ts` regressed.

- [ ] **Step 5: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts src/utils/logger.ts
git commit -m "feat(dedup-fold): add settings keys + DEDUP logger component"
```

---

### Task 3: `loadDedupFoldConfig` + cache

**Files:**
- Modify: `src/services/worker/dedup-fold.ts`
- Modify: `tests/services/worker/dedup-fold.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/services/worker/dedup-fold.test.ts`:

```ts
import { loadDedupFoldConfig, getDedupFoldConfig, _resetDedupFoldConfigCache } from '../../../src/services/worker/dedup-fold.js';

describe('loadDedupFoldConfig', () => {
  function settingsFrom(overrides: Record<string, string>): any {
    return {
      CLAUDE_MEM_DEDUP_FOLD_ENABLED: 'false',
      CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '30',
      CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS: '',
      ...overrides,
    };
  }

  it('defaults: enabled=false, windowSeconds=30, disabledTools=[]', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({}));
    expect(cfg.enabled).toBe(false);
    expect(cfg.windowSeconds).toBe(30);
    expect(cfg.disabledTools).toEqual([]);
  });

  it('parses enabled boolean', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_ENABLED: 'true' }));
    expect(cfg.enabled).toBe(true);
  });

  it('parses windowSeconds integer', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '60' }));
    expect(cfg.windowSeconds).toBe(60);
  });

  it('falls back to 30 on non-integer windowSeconds', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: 'not-a-number' }));
    expect(cfg.windowSeconds).toBe(30);
  });

  it('clamps windowSeconds to [1, 3600]', () => {
    const lo = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '0' }));
    expect(lo.windowSeconds).toBe(30);
    const hi = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '9999' }));
    expect(hi.windowSeconds).toBe(30);
  });

  it('splits and trims disabledTools CSV', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS: 'Bash, Edit ,  ' }));
    expect(cfg.disabledTools).toEqual(['Bash', 'Edit']);
  });
});

describe('getDedupFoldConfig cache', () => {
  it('reset works', () => {
    _resetDedupFoldConfigCache();
    const a = getDedupFoldConfig();
    _resetDedupFoldConfigCache();
    const b = getDedupFoldConfig();
    expect(a).not.toBe(b); // different object references after reset
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/worker/dedup-fold.test.ts`

Expected: FAIL with "loadDedupFoldConfig is not a function" / cannot import.

- [ ] **Step 3: Extend `dedup-fold.ts`**

Append to `src/services/worker/dedup-fold.ts`:

```ts
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

export interface DedupFoldConfig {
  enabled: boolean;
  windowSeconds: number;
  disabledTools: string[];
}

const DEFAULT_WINDOW_SECONDS = 30;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 3600;

export function loadDedupFoldConfig(settings: Record<string, string>): DedupFoldConfig {
  const enabled = settings.CLAUDE_MEM_DEDUP_FOLD_ENABLED === 'true';

  let windowSeconds = DEFAULT_WINDOW_SECONDS;
  const raw = settings.CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS;
  const parsed = parseInt(raw ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= MIN_WINDOW_SECONDS && parsed <= MAX_WINDOW_SECONDS) {
    windowSeconds = parsed;
  } else if (raw && raw !== String(DEFAULT_WINDOW_SECONDS)) {
    logger.warn('DEDUP', 'invalid CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS, using default', undefined, { raw, default: DEFAULT_WINDOW_SECONDS });
  }

  const disabledTools = (settings.CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { enabled, windowSeconds, disabledTools };
}

const CACHE_TTL_MS = 5_000;
let cached: { config: DedupFoldConfig; expiresAt: number } | null = null;

export function getDedupFoldConfig(): DedupFoldConfig {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;
  const config = loadDedupFoldConfig(SettingsDefaultsManager.loadAll());
  cached = { config, expiresAt: now + CACHE_TTL_MS };
  return config;
}

export function _resetDedupFoldConfigCache(): void {
  cached = null;
}
```

**Note:** Verify that `SettingsDefaultsManager.loadAll()` is the correct API by checking the file — adjust if it's `getAll()`, `read()`, or similar.

- [ ] **Step 4: Verify the SettingsDefaultsManager API call matches existing usage**

Run: `grep -rn "SettingsDefaultsManager\." /Users/liguanchen/Desktop/lgc/claude-mem/src/utils/redaction.ts 2>/dev/null`

Use the same method name as `redaction.ts` (which we know works from S2). Fix the call in `dedup-fold.ts` if needed.

- [ ] **Step 5: Run tests**

Run: `bun test tests/services/worker/dedup-fold.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/dedup-fold.ts tests/services/worker/dedup-fold.test.ts
git commit -m "feat(dedup-fold): loadDedupFoldConfig + 5s cached getDedupFoldConfig"
```

---

### Task 4: Schema migration (version 35)

**Files:**
- Modify: `src/services/sqlite/schema.sql`
- Modify: `src/services/sqlite/migrations/runner.ts`
- Test: `tests/services/sqlite/migrations/dedup-fold-migration.test.ts`

- [ ] **Step 1: Read current schema and migration version**

Run: `grep -n "CREATE TABLE pending_messages\|fold_" /Users/liguanchen/Desktop/lgc/claude-mem/src/services/sqlite/schema.sql`
Run: `grep -n "schema_versions.*VALUES" /Users/liguanchen/Desktop/lgc/claude-mem/src/services/sqlite/migrations/runner.ts | tail -5`

Confirm version 34 is the current max (spec §6.2). If it differs at implementation time, use the next free number and update the migration block accordingly.

- [ ] **Step 2: Write the failing migration test**

```ts
// tests/services/sqlite/migrations/dedup-fold-migration.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../../src/services/sqlite/migrations/runner.js';

describe('migration v35: pending_messages fold columns', () => {
  it('adds fold_key and fold_count columns + index', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.run();

    const cols = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string; dflt_value: any; notnull: number }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('fold_key');
    expect(names).toContain('fold_count');

    const foldCount = cols.find((c) => c.name === 'fold_count')!;
    expect(foldCount.notnull).toBe(1);
    expect(String(foldCount.dflt_value)).toBe('1');

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_fold'").get();
    expect(idx).toBeTruthy();
  });

  it('is idempotent (running twice does not throw)', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.run();
    expect(() => runner.run()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/services/sqlite/migrations/dedup-fold-migration.test.ts`

Expected: FAIL — `fold_key` column not in `pending_messages`.

- [ ] **Step 4: Add columns to baseline schema**

In `src/services/sqlite/schema.sql`, locate the `CREATE TABLE pending_messages (...)` block and add inside the column list:

```sql
  fold_key TEXT,
  fold_count INTEGER NOT NULL DEFAULT 1,
```

Below the `CREATE TABLE pending_messages` block, add the index:

```sql
CREATE INDEX IF NOT EXISTS idx_pending_fold
  ON pending_messages(session_db_id, fold_key, created_at_epoch);
```

This is the fresh-DB baseline. Existing installs come through the migration runner.

- [ ] **Step 5: Add migration version 35 to runner.ts**

In `src/services/sqlite/migrations/runner.ts`, after the last existing migration block (currently ending at version 34), add:

```ts
    // Migration 35: dedup fold columns on pending_messages
    const applied35 = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(35) as SchemaVersion | undefined;
    if (!applied35) {
      this.db.exec(`
        ALTER TABLE pending_messages ADD COLUMN fold_key TEXT;
        ALTER TABLE pending_messages ADD COLUMN fold_count INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX IF NOT EXISTS idx_pending_fold
          ON pending_messages(session_db_id, fold_key, created_at_epoch);
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
    }
```

**Variable naming:** existing migrations in the file use the local name `applied` repeatedly. To avoid TS shadowing warnings, name yours `applied35` (or match the file's actual scoping style — check before editing).

- [ ] **Step 6: Run migration test**

Run: `bun test tests/services/sqlite/migrations/dedup-fold-migration.test.ts`

Expected: both tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/sqlite/schema.sql src/services/sqlite/migrations/runner.ts tests/services/sqlite/migrations/dedup-fold-migration.test.ts
git commit -m "feat(dedup-fold): schema migration v35 — fold_key + fold_count on pending_messages"
```

---

### Task 5: `PendingMessageStore` — `findFoldCandidate` + `bumpFoldCount`

**Files:**
- Modify: `src/services/sqlite/PendingMessageStore.ts`
- Test: `tests/services/sqlite/PendingMessageStore.fold.test.ts`

- [ ] **Step 1: Read current store to find enqueue signature and DB column names**

Run: `grep -n "enqueue\|class PendingMessageStore\|prepare(" /Users/liguanchen/Desktop/lgc/claude-mem/src/services/sqlite/PendingMessageStore.ts | head -30`

Note the existing `enqueue` parameters — we will extend it to accept an optional `foldKey`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/services/sqlite/PendingMessageStore.fold.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';

function makeDb() {
  const db = new Database(':memory:');
  new MigrationRunner(db).run();
  // Seed a minimal sdk_session row so foreign keys (if any) and session_db_id values resolve.
  db.exec(`INSERT INTO sdk_sessions (id, content_session_id, project, created_at_epoch) VALUES (1, 'sess-1', 'proj', ${Date.now()})`);
  return db;
}

describe('PendingMessageStore.findFoldCandidate', () => {
  it('returns null when no matching row exists', () => {
    const db = makeDb();
    const store = new PendingMessageStore(db);
    const hit = store.findFoldCandidate(1, 'abc1234567890abc', 30_000, Date.now());
    expect(hit).toBeNull();
  });

  it('returns the most recent row inside the window', () => {
    const db = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    db.exec(`INSERT INTO pending_messages (content_session_id, session_db_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch, fold_key, fold_count) VALUES ('sess-1', 1, 'tu-1', 'Bash', '{}', '{}', ${now - 10_000}, 'foldkey-aaa', 1)`);
    const hit = store.findFoldCandidate(1, 'foldkey-aaa', 30_000, now);
    expect(hit).not.toBeNull();
    expect(hit!.createdAtEpoch).toBe(now - 10_000);
  });

  it('returns null when the row is outside the window', () => {
    const db = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    db.exec(`INSERT INTO pending_messages (content_session_id, session_db_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch, fold_key, fold_count) VALUES ('sess-1', 1, 'tu-1', 'Bash', '{}', '{}', ${now - 60_000}, 'foldkey-aaa', 1)`);
    const hit = store.findFoldCandidate(1, 'foldkey-aaa', 30_000, now);
    expect(hit).toBeNull();
  });

  it('isolates by session_db_id', () => {
    const db = makeDb();
    db.exec(`INSERT INTO sdk_sessions (id, content_session_id, project, created_at_epoch) VALUES (2, 'sess-2', 'proj', ${Date.now()})`);
    const store = new PendingMessageStore(db);
    const now = Date.now();
    db.exec(`INSERT INTO pending_messages (content_session_id, session_db_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch, fold_key, fold_count) VALUES ('sess-2', 2, 'tu-1', 'Bash', '{}', '{}', ${now - 5_000}, 'foldkey-aaa', 1)`);
    const hit = store.findFoldCandidate(1, 'foldkey-aaa', 30_000, now);
    expect(hit).toBeNull();
  });
});

describe('PendingMessageStore.bumpFoldCount', () => {
  it('increments fold_count and returns the new value', () => {
    const db = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    db.exec(`INSERT INTO pending_messages (id, content_session_id, session_db_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch, fold_key, fold_count) VALUES (42, 'sess-1', 1, 'tu-1', 'Bash', '{}', '{}', ${now}, 'foldkey-aaa', 3)`);
    const result = store.bumpFoldCount(42);
    expect(result.newCount).toBe(4);
    const row = db.prepare('SELECT fold_count FROM pending_messages WHERE id = 42').get() as { fold_count: number };
    expect(row.fold_count).toBe(4);
  });
});
```

**Note:** The exact column names (`content_session_id`, `session_db_id`, `tool_use_id`, etc.) come from the current schema. If the seed INSERT fails on a NOT NULL column not listed above, add it from `schema.sql`'s pending_messages definition before running.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/services/sqlite/PendingMessageStore.fold.test.ts`

Expected: FAIL — `findFoldCandidate is not a function`.

- [ ] **Step 4: Implement the two methods**

In `src/services/sqlite/PendingMessageStore.ts`, add inside the `PendingMessageStore` class:

```ts
findFoldCandidate(
  sessionDbId: number,
  foldKey: string,
  windowMs: number,
  now: number,
): { id: number; createdAtEpoch: number } | null {
  const minEpoch = now - windowMs;
  const row = this.db
    .prepare(
      `SELECT id, created_at_epoch FROM pending_messages
       WHERE session_db_id = ? AND fold_key = ? AND created_at_epoch >= ?
       ORDER BY created_at_epoch DESC LIMIT 1`
    )
    .get(sessionDbId, foldKey, minEpoch) as { id: number; created_at_epoch: number } | undefined;
  if (!row) return null;
  return { id: row.id, createdAtEpoch: row.created_at_epoch };
}

bumpFoldCount(rowId: number): { newCount: number } {
  this.db
    .prepare('UPDATE pending_messages SET fold_count = fold_count + 1 WHERE id = ?')
    .run(rowId);
  const row = this.db
    .prepare('SELECT fold_count FROM pending_messages WHERE id = ?')
    .get(rowId) as { fold_count: number } | undefined;
  if (!row) {
    throw new Error(`bumpFoldCount: row ${rowId} not found after update`);
  }
  return { newCount: row.fold_count };
}
```

Also extend the existing `enqueue(...)` signature to accept an optional `foldKey: string | null` parameter and persist it into the INSERT statement's `fold_key` column. Match whatever parameter style the existing method uses (positional vs object).

- [ ] **Step 5: Run tests**

Run: `bun test tests/services/sqlite/PendingMessageStore.fold.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/sqlite/PendingMessageStore.ts tests/services/sqlite/PendingMessageStore.fold.test.ts
git commit -m "feat(dedup-fold): PendingMessageStore findFoldCandidate + bumpFoldCount + enqueue foldKey"
```

---

### Task 6: `shouldFold` decision function

**Files:**
- Modify: `src/services/worker/dedup-fold.ts`
- Modify: `tests/services/worker/dedup-fold.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/services/worker/dedup-fold.test.ts`:

```ts
import { shouldFold } from '../../../src/services/worker/dedup-fold.js';

describe('shouldFold decision', () => {
  function makeStore(overrides: Partial<Record<string, any>> = {}) {
    return {
      findFoldCandidate: () => null,
      ...overrides,
    } as any;
  }

  const baseObs = {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    cwd: '/repo',
    agent_id: 'main',
    created_at_epoch: 1_000_000,
  };

  it('returns {fold:false} when feature disabled', () => {
    const r = shouldFold(baseObs, 1, { enabled: false, windowSeconds: 30, disabledTools: [] }, makeStore());
    expect(r.fold).toBe(false);
  });

  it('returns {fold:false} when tool is in disabledTools', () => {
    const r = shouldFold(baseObs, 1, { enabled: true, windowSeconds: 30, disabledTools: ['Bash'] }, makeStore());
    expect(r.fold).toBe(false);
  });

  it('returns {fold:false, foldKey} when no prior row exists', () => {
    const r = shouldFold(baseObs, 1, { enabled: true, windowSeconds: 30, disabledTools: [] }, makeStore());
    expect(r.fold).toBe(false);
    expect((r as any).foldKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns {fold:true, foldOntoRowId} when a candidate exists', () => {
    const store = makeStore({
      findFoldCandidate: () => ({ id: 42, createdAtEpoch: 999_990 }),
    });
    const r = shouldFold(baseObs, 1, { enabled: true, windowSeconds: 30, disabledTools: [] }, store);
    expect(r.fold).toBe(true);
    expect((r as any).foldOntoRowId).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/worker/dedup-fold.test.ts`

Expected: FAIL — `shouldFold is not a function`.

- [ ] **Step 3: Implement `shouldFold`**

Append to `src/services/worker/dedup-fold.ts`:

```ts
export interface FoldStoreLike {
  findFoldCandidate(
    sessionDbId: number,
    foldKey: string,
    windowMs: number,
    now: number,
  ): { id: number; createdAtEpoch: number } | null;
}

export interface PendingObservationForFold {
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  agent_id?: string;
  created_at_epoch: number;
}

export type DedupFoldDecision =
  | { fold: true; foldOntoRowId: number }
  | { fold: false; foldKey?: string };

export function shouldFold(
  obs: PendingObservationForFold,
  sessionDbId: number,
  config: DedupFoldConfig,
  store: FoldStoreLike,
): DedupFoldDecision {
  if (!config.enabled) return { fold: false };
  if (config.disabledTools.includes(obs.tool_name)) return { fold: false };

  const foldKey = computeFoldKey({
    tool_name: obs.tool_name,
    tool_input: obs.tool_input,
    cwd: obs.cwd,
    agent_id: obs.agent_id,
  });

  const candidate = store.findFoldCandidate(
    sessionDbId,
    foldKey,
    config.windowSeconds * 1000,
    obs.created_at_epoch,
  );

  if (candidate) {
    return { fold: true, foldOntoRowId: candidate.id };
  }
  return { fold: false, foldKey };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/services/worker/dedup-fold.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/dedup-fold.ts tests/services/worker/dedup-fold.test.ts
git commit -m "feat(dedup-fold): shouldFold decision (enable/disable/window-check)"
```

---

### Task 7: SDK prompt — `<repetition>` injection

**Files:**
- Modify: `src/sdk/prompts.ts`
- Test: `tests/sdk/prompts.fold.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sdk/prompts.fold.test.ts
import { describe, it, expect } from 'bun:test';
import { buildObservationPrompt } from '../../src/sdk/prompts.js';
import { _resetDedupFoldConfigCache } from '../../src/services/worker/dedup-fold.js';

describe('buildObservationPrompt repetition hint', () => {
  it('does NOT include <repetition> when fold_count is 1 or undefined', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: '{"command":"ls"}',
      tool_output: '{}',
      created_at_epoch: Date.now(),
    });
    expect(prompt).not.toContain('<repetition>');
  });

  it('includes <repetition> when fold_count > 1', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: '{"command":"ls"}',
      tool_output: '{}',
      created_at_epoch: Date.now(),
      fold_count: 5,
    });
    expect(prompt).toContain('<repetition>');
    expect(prompt).toMatch(/repeated 5 times/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sdk/prompts.fold.test.ts`

Expected: FAIL — `<repetition>` not emitted.

- [ ] **Step 3: Extend the `Observation` interface**

In `src/sdk/prompts.ts`, extend the `Observation` interface:

```ts
export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
  fold_count?: number;
}
```

- [ ] **Step 4: Emit `<repetition>` inside `buildObservationPrompt`**

In `src/sdk/prompts.ts`, change the `buildObservationPrompt` signature to accept an optional `opts` parameter — do NOT import from `services/worker/*` (that would create a reverse `sdk → worker` dependency; the worker layer already imports from `sdk`). The window is injected by the caller (`SessionManager` in Task 8).

```ts
export function buildObservationPrompt(
  obs: Observation,
  opts?: { windowSeconds?: number },
): string
```

Inside `buildObservationPrompt`, after computing `toolInput` and `toolOutput`, build the optional repetition element using the injected window (default 30, matching `DEFAULT_WINDOW_SECONDS` in `dedup-fold.ts`):

```ts
const foldCount = obs.fold_count ?? 1;
let repetitionLine = '';
if (foldCount > 1) {
  const windowSec = opts?.windowSeconds ?? 30;
  repetitionLine = `\n  <repetition>This tool call was repeated ${foldCount} times in a ${windowSec}s window.</repetition>`;
}
```

Task 8 will pass `{ windowSeconds: getDedupFoldConfig().windowSeconds }` at every call site (`SessionManager`/Provider).

Then in the returned template, insert `${repetitionLine}` between the `<outcome>` element and the closing `</observed_from_primary_session>`:

```ts
  return `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>${repetitionLine}
</observed_from_primary_session>

Return either one or more <observation>...</observation> blocks, or an empty response if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.

If a <parameters> or <outcome> block above contains a "<redacted type='...' />" marker, that field was a recognized secret pattern and was removed before storage. Treat it as a placeholder; do not infer the literal value.

Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.`;
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/sdk/prompts.fold.test.ts`

Expected: both pass.

Also run the full prompts test suite to confirm no regression:

Run: `bun test tests/sdk/`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/sdk/prompts.ts tests/sdk/prompts.fold.test.ts
git commit -m "feat(dedup-fold): emit <repetition> hint in buildObservationPrompt when fold_count > 1"
```

---

### Task 8: `SessionManager.queueObservation` wire-up + iterator projection

**Files:**
- Modify: `src/services/worker/SessionManager.ts`
- Modify: `src/services/sqlite/PendingMessageStore.ts` (iterator projection if applicable)

- [ ] **Step 1: Read current `queueObservation` and message-iterator paths**

Run: `grep -n "queueObservation\|getMessageIterator\|fold_count\|fold_key" /Users/liguanchen/Desktop/lgc/claude-mem/src/services/worker/SessionManager.ts /Users/liguanchen/Desktop/lgc/claude-mem/src/services/sqlite/PendingMessageStore.ts | head -40`

Identify:
1. Where `queueObservation` calls `PendingMessageStore.enqueue` (the fold check goes immediately before).
2. Where the message iterator's SELECT projects pending columns (must include `fold_count`).

- [ ] **Step 2: Add fold decision in `queueObservation`**

In `src/services/worker/SessionManager.ts`, inside `queueObservation`, immediately before the `PendingMessageStore.enqueue` call:

```ts
import { shouldFold, getDedupFoldConfig } from './dedup-fold.js';
import { logger } from '../../utils/logger.js';

// ... inside queueObservation, after extracting sessionDbId and the obs payload ...

const dedupConfig = getDedupFoldConfig();
const decision = shouldFold(
  {
    tool_name: obs.tool_name,
    tool_input: typeof obs.tool_input === 'string' ? safeParseJson(obs.tool_input) : obs.tool_input,
    cwd: obs.cwd,
    agent_id: obs.agent_id,
    created_at_epoch: obs.created_at_epoch,
  },
  sessionDbId,
  dedupConfig,
  this.pendingStore,
);

if (decision.fold) {
  const { newCount } = this.pendingStore.bumpFoldCount(decision.foldOntoRowId);
  logger.debug('DEDUP', 'folded duplicate observation', undefined, {
    rowId: decision.foldOntoRowId,
    newCount,
    toolName: obs.tool_name,
  });
  return { folded: true, rowId: decision.foldOntoRowId };
}

// Otherwise proceed with normal enqueue, passing the fold_key:
const messageId = this.pendingStore.enqueue({
  // ... existing fields ...
  foldKey: decision.foldKey ?? null,
});
```

**Helper:** if `safeParseJson` is not already in scope, define it inline at module top:

```ts
function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
```

**Caller updates:** if `queueObservation` callers handle the return shape, ensure the new `{ folded: true }` branch is harmless (e.g. the caller should NOT call `ensureGeneratorRunning` on a folded result). Read the call sites and adjust if needed.

- [ ] **Step 3: Project `fold_count` in the message iterator**

Find the SELECT used by `getMessageIterator` (likely in `PendingMessageStore.ts` or `SessionManager.ts`). Ensure `fold_count` is in the projection and mapped into the `Observation` object returned to `buildObservationPrompt`:

```ts
// Example projection update:
const row = this.db.prepare(
  `SELECT id, tool_name, tool_input, tool_response, cwd, created_at_epoch, fold_count
   FROM pending_messages WHERE session_db_id = ? AND ... ORDER BY ...`
).get(...) as PendingRow;

return {
  id: row.id,
  tool_name: row.tool_name,
  tool_input: row.tool_input,
  tool_output: row.tool_response,
  created_at_epoch: row.created_at_epoch,
  cwd: row.cwd ?? undefined,
  fold_count: row.fold_count ?? 1,
};
```

- [ ] **Step 4: Typecheck the wire-up**

Run: `cd /Users/liguanchen/Desktop/lgc/claude-mem && bunx tsc --noEmit 2>&1 | grep -E "(dedup-fold|SessionManager|PendingMessageStore)" | head -20`

Expected: no new errors mentioning these files. End-to-end behavioral tests for this wire-up live in Task 9; treat this typecheck as the gate for committing.

- [ ] **Step 5: Re-run existing worker tests for regression**

Run: `bun test tests/services/worker/ tests/services/sqlite/ 2>&1 | tail -20`

Expected: existing tests still pass (no regressions from the call-site signature change).

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/SessionManager.ts src/services/sqlite/PendingMessageStore.ts
git commit -m "feat(dedup-fold): wire shouldFold into queueObservation + project fold_count in iterator"
```

---

### Task 9: End-to-end integration test

**Files:**
- Test: `tests/integration/dedup-fold-wired.test.ts`

- [ ] **Step 1: Inspect existing integration test fixtures**

Run: `ls /Users/liguanchen/Desktop/lgc/claude-mem/tests/integration/ && grep -l "MigrationRunner\|SessionManager" /Users/liguanchen/Desktop/lgc/claude-mem/tests/integration/*.ts 2>/dev/null`

Use any helper that constructs a worker-side SQLite DB + SessionManager. Otherwise, build one with `:memory:` + `MigrationRunner` directly in the test.

- [ ] **Step 2: Write the end-to-end test**

```ts
// tests/integration/dedup-fold-wired.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import {
  shouldFold,
  computeFoldKey,
  _resetDedupFoldConfigCache,
} from '../../src/services/worker/dedup-fold.js';

function setupDb(): { db: Database; store: PendingMessageStore; sessionDbId: number } {
  const db = new Database(':memory:');
  new MigrationRunner(db).run();
  const now = Date.now();
  db.exec(`INSERT INTO sdk_sessions (id, content_session_id, project, created_at_epoch) VALUES (1, 'sess-1', 'proj', ${now})`);
  return { db, store: new PendingMessageStore(db), sessionDbId: 1 };
}

function insertObs(db: Database, sessionDbId: number, foldKey: string | null, createdAt: number, idHint: string): number {
  const r = db.prepare(
    `INSERT INTO pending_messages (content_session_id, session_db_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch, fold_key, fold_count) VALUES ('sess-1', ?, ?, 'Bash', '{"command":"ls"}', '{}', ?, ?, 1) RETURNING id`,
  ).get(sessionDbId, idHint, createdAt, foldKey) as { id: number };
  return r.id;
}

describe('dedup-fold end-to-end', () => {
  beforeEach(() => { _resetDedupFoldConfigCache(); });
  afterEach(() => { _resetDedupFoldConfigCache(); });

  it('5x identical Bash(ls) within 30s = 1 pending row, fold_count=5', () => {
    const { db, store, sessionDbId } = setupDb();
    const config = { enabled: true, windowSeconds: 30, disabledTools: [] };
    const now = Date.now();

    const obs = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo', agent_id: 'main', created_at_epoch: now };
    const foldKey = computeFoldKey(obs);

    // First call — no candidate, insert.
    let decision = shouldFold(obs, sessionDbId, config, store);
    expect(decision.fold).toBe(false);
    insertObs(db, sessionDbId, foldKey, now, 'tu-1');

    // Subsequent 4 calls — fold onto the first.
    for (let i = 2; i <= 5; i++) {
      decision = shouldFold({ ...obs, created_at_epoch: now + i * 1000 }, sessionDbId, config, store);
      expect(decision.fold).toBe(true);
      store.bumpFoldCount((decision as any).foldOntoRowId);
    }

    const rows = db.prepare('SELECT id, fold_count FROM pending_messages').all() as Array<{ id: number; fold_count: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].fold_count).toBe(5);
  });

  it('crossing the 30s window opens a new row', () => {
    const { db, store, sessionDbId } = setupDb();
    const config = { enabled: true, windowSeconds: 30, disabledTools: [] };
    const obs = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo', agent_id: 'main', created_at_epoch: 1_000_000 };
    const foldKey = computeFoldKey(obs);

    insertObs(db, sessionDbId, foldKey, 1_000_000, 'tu-a');
    const decision = shouldFold({ ...obs, created_at_epoch: 1_000_000 + 31_000 }, sessionDbId, config, store);
    expect(decision.fold).toBe(false);
  });

  it('disabled feature → never folds', () => {
    const { db, store, sessionDbId } = setupDb();
    const config = { enabled: false, windowSeconds: 30, disabledTools: [] };
    const obs = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo', agent_id: 'main', created_at_epoch: Date.now() };
    insertObs(db, sessionDbId, computeFoldKey(obs), Date.now(), 'tu-1');
    const decision = shouldFold(obs, sessionDbId, config, store);
    expect(decision.fold).toBe(false);
  });

  it('tool in disabledTools → never folds', () => {
    const { db, store, sessionDbId } = setupDb();
    const config = { enabled: true, windowSeconds: 30, disabledTools: ['Bash'] };
    const obs = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo', agent_id: 'main', created_at_epoch: Date.now() };
    insertObs(db, sessionDbId, computeFoldKey(obs), Date.now(), 'tu-1');
    const decision = shouldFold(obs, sessionDbId, config, store);
    expect(decision.fold).toBe(false);
  });

  it('subagent isolation: different agent_id does not fold', () => {
    const { db, store, sessionDbId } = setupDb();
    const config = { enabled: true, windowSeconds: 30, disabledTools: [] };
    const now = Date.now();

    const obsMain = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo', agent_id: 'main', created_at_epoch: now };
    insertObs(db, sessionDbId, computeFoldKey(obsMain), now, 'tu-main');

    const obsSub = { ...obsMain, agent_id: 'sub-1' };
    const decision = shouldFold(obsSub, sessionDbId, config, store);
    expect(decision.fold).toBe(false);
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `bun test tests/integration/dedup-fold-wired.test.ts`

Expected: all 5 pass.

- [ ] **Step 4: Run the entire test suite for regression check**

Run: `bun test 2>&1 | tail -20`

Expected: no new failures introduced by this feature. If `SessionManager` tests fail due to constructor changes, fix them before commit (the integration test should also have caught the missing wire-up).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/dedup-fold-wired.test.ts
git commit -m "test(dedup-fold): end-to-end fold + window + isolation cases"
```

---

### Task 10: User-facing documentation

**Files:**
- Create: `docs/public/usage/dedup-folding.mdx`

- [ ] **Step 1: Read the S2 doc as the style reference**

Run: `cat /Users/liguanchen/Desktop/lgc/claude-mem/docs/public/usage/auto-redaction.mdx | head -80`

Match the frontmatter, tone, and structure.

- [ ] **Step 2: Write the doc**

```mdx
---
title: 'Dedup Folding'
description: 'Collapse identical tool calls within a short window to save SDK tokens.'
---

import { Callout } from '/snippets/Callout.jsx';

Claude-mem normally sends one Claude Agent SDK turn per tool use. When a user
polls (`while sleep 5; do ls; done`) or hits a retry loop, that means many
near-identical SDK calls in a short window.

**Dedup folding** collapses byte-identical tool calls within a sliding time
window into a single SDK turn. The pending row's `fold_count` is bumped instead
of enqueuing a new prompt, and the resulting observation prompt carries a
`<repetition>` hint so Claude knows the call recurred.

This feature is **opt-in** — enable it via settings.

## Quick start

In `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_DEDUP_FOLD_ENABLED": "true",
  "CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS": "30",
  "CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS": ""
}
```

Restart the worker (`claude-mem restart`) so the new settings take effect.

## How it works

For each PostToolUse event, claude-mem computes a fold key:

```
sha256(tool_name + canonical(tool_input) + cwd + agent_id).slice(0, 16)
```

It then looks up the most recent pending row with the same key inside the
current session, created within the configured window. If found, the existing
row's `fold_count` is incremented. Otherwise a new row is enqueued normally.

When the message iterator finally drains the row to the SDK,
`buildObservationPrompt` appends:

```xml
<repetition>This tool call was repeated 5 times in a 30s window.</repetition>
```

The observer model decides whether to surface the repetition in its
`<facts>` output.

## Settings reference

| Setting                                    | Default | Meaning                                          |
|--------------------------------------------|---------|--------------------------------------------------|
| `CLAUDE_MEM_DEDUP_FOLD_ENABLED`            | `false` | Master switch.                                   |
| `CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS`     | `30`    | Sliding window. Valid range: 1–3600 seconds.     |
| `CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS`     | `""`    | CSV of tool names to never fold (e.g. `Bash`).   |

## What gets folded

A call only folds onto a prior call if **all** of these match:

- `tool_name` (e.g. `Bash` vs `Read`)
- `tool_input` (JSON keys are sorted canonically, so object reordering is fine)
- `cwd` (working directory)
- `agent_id` (main vs subagent traces stay separate)
- The prior call is within the configured time window
- Both calls are in the same claude-mem session

## What does NOT fold

- Calls in different sessions
- Calls in different working directories
- Calls from different agents (subagent vs main)
- Calls outside the configured window
- Tools listed in `CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS`
- Anything if `CLAUDE_MEM_DEDUP_FOLD_ENABLED=false`

## Caveats

<Callout type="warning">
**Same input, different output:** `Bash("npm test")` may produce different
outputs across runs (flaky tests). The fold key only hashes the input, so all
runs fold onto the first. If you need every run's output preserved separately,
add `Bash` to `CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS`.
</Callout>

## Interaction with other dedup layers

Claude-mem already had two dedup layers — fold is a third, complementary one:

| Layer            | Where             | What it catches                                       |
|------------------|-------------------|-------------------------------------------------------|
| Hook retry       | Queue ingress     | Same hook fires twice (`tool_use_id` collision)       |
| **Fold (new)**   | Pre-SDK           | Byte-identical calls within a time window             |
| Content hash     | Post-SDK store    | Different inputs that produce the same summary        |

Fold reduces SDK round-trips. Content-hash dedup reduces stored row count when
the SDK output is identical.

## See also

- [Auto-redaction](/usage/auto-redaction) — sister opt-in feature for redacting
  secret patterns before they reach the SDK.
- [`<private>` tags](/usage/private-tags) — manual privacy control.
```

- [ ] **Step 3: Check docs.json for navigation registration**

Run: `grep -n "auto-redaction\|usage/" /Users/liguanchen/Desktop/lgc/claude-mem/docs/public/docs.json | head -20`

If `auto-redaction.mdx` is registered in `docs.json` navigation, add `usage/dedup-folding` next to it. Match the format exactly.

- [ ] **Step 4: Commit**

```bash
git add docs/public/usage/dedup-folding.mdx docs/public/docs.json
git commit -m "docs(dedup-fold): user-facing guide + nav registration"
```

---

## Post-Implementation Verification

After all 10 tasks land, run:

```bash
cd /Users/liguanchen/Desktop/lgc/claude-mem
bun test 2>&1 | tail -30
bunx tsc --noEmit 2>&1 | tail -20
npm run build-and-sync  # if tests pass — produces plugin/scripts/worker-service.cjs
```

Manually verify:

1. Fresh DB — `CLAUDE_MEM_DEDUP_FOLD_ENABLED=false` (default): no behavior change, no new rows show `fold_count` in observations.
2. Toggle on, restart worker, run `while sleep 1; do ls; done` for ~10 cycles in a claude session, observe in DB: `SELECT tool_name, fold_count FROM pending_messages WHERE fold_count > 1;` should show the folded row(s).
3. Open the viewer (worker port) — confirm the resulting observation surfaces the repetition (e.g. in a fact line like "executed 10 times").

## Polish Follow-ups (not blockers)

- **Future:** when `fold_count > 1` enters Chroma sync, consider boosting embedding weight so repeated calls remain searchable.
- **Future:** expose `fold_count` in the viewer UI as a small badge.
- **Future:** offer a `claude-mem stats fold` CLI subcommand to report how much SDK volume the fold has saved.
- **Future:** add `CLAUDE_MEM_DEDUP_FOLD_PER_TOOL_WINDOW` if real usage shows different tools want different windows.

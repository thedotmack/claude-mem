import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import {
  enqueueOutbox,
  claimPending,
  markDone,
  markQuarantined,
  bumpAttempts,
  countByStatus,
  oldestPendingAgeMs,
} from '../../src/services/cloud/outbox.js';
import { ensureCloudOutboxTable, CLOUD_OUTBOX_SCHEMA_VERSION } from '../../src/services/cloud/migration.js';
import { __setCloudEnabledForTest } from '../../src/services/cloud/config.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';

function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1', 'fact2'],
    narrative: 'Test narrative content',
    concepts: ['concept1', 'concept2'],
    files_read: ['/path/to/file1.ts'],
    files_modified: ['/path/to/file2.ts'],
    ...overrides,
  };
}

function seedSession(db: Database, contentId: string, memoryId: string, project = 'test-project'): string {
  const sessionDbId = createSDKSession(db, contentId, project, 'initial prompt');
  updateMemorySessionId(db, sessionDbId, memoryId);
  return memoryId;
}

describe('cloud_outbox migration', () => {
  it('creates cloud_outbox via the runner suite (ClaudeMemDatabase)', () => {
    const db = new ClaudeMemDatabase(':memory:').db;
    const cols = db.query('PRAGMA table_info(cloud_outbox)').all();
    expect(cols.length).toBeGreaterThan(0);
    db.close();
  });

  it('is idempotent: running ensureCloudOutboxTable twice does not throw', () => {
    const db = new ClaudeMemDatabase(':memory:').db;
    expect(() => {
      ensureCloudOutboxTable(db);
      ensureCloudOutboxTable(db);
    }).not.toThrow();
    db.close();
  });

  it('is clean when BOTH suites run against the same DB', () => {
    // ClaudeMemDatabase already ran the runner suite (which calls ensureCloudOutboxTable).
    const db = new ClaudeMemDatabase(':memory:').db;
    // Now run the SessionStore suite against the SAME db handle.
    expect(() => new SessionStore(db)).not.toThrow();
    // Table still exists exactly once and the version row is single.
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_outbox'")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
    const versions = db
      .prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = ?')
      .get(CLOUD_OUTBOX_SCHEMA_VERSION) as { n: number };
    expect(versions.n).toBe(1);
    db.close();
  });

  it('idempotent when starting from a raw runner-built DB run twice', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();
    expect(() => new MigrationRunner(db).runAllMigrations()).not.toThrow();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_outbox'")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
    db.close();
  });
});

describe('storeObservations + outbox (cloud ENABLED)', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    __setCloudEnabledForTest(true);
  });

  afterEach(() => {
    __setCloudEnabledForTest(null);
    db.close();
  });

  it('inserts N observations AND N outbox rows in the same transaction, referencing the right local_ids', () => {
    const memoryId = seedSession(db, 'content-enabled-1', 'memory-enabled-1');
    const observations = [
      createObservationInput({ title: 'Obs 1' }),
      createObservationInput({ title: 'Obs 2' }),
      createObservationInput({ title: 'Obs 3' }),
    ];

    const result = storeObservations(db, memoryId, 'test-project', observations);
    expect(result.observationIds.length).toBe(3);

    const outboxRows = db
      .prepare("SELECT * FROM cloud_outbox WHERE kind = 'observation' ORDER BY id")
      .all() as Array<{ local_id: number; kind: string; status: string; lane: string }>;
    expect(outboxRows.length).toBe(3);

    const outboxLocalIds = outboxRows.map(r => r.local_id).sort((a, b) => a - b);
    const obsIds = [...result.observationIds].sort((a, b) => a - b);
    expect(outboxLocalIds).toEqual(obsIds);
    expect(outboxRows.every(r => r.status === 'pending' && r.lane === 'live')).toBe(true);
  });

  it('enqueues a summary outbox row when a summary is stored', () => {
    const memoryId = seedSession(db, 'content-enabled-2', 'memory-enabled-2');
    const result = storeObservations(db, memoryId, 'test-project', [createObservationInput()], {
      request: 'r',
      investigated: 'i',
      learned: 'l',
      completed: 'c',
      next_steps: 'n',
      notes: null,
    });
    expect(result.summaryId).not.toBeNull();
    const summaryOutbox = db
      .prepare("SELECT * FROM cloud_outbox WHERE kind = 'summary'")
      .all() as Array<{ local_id: number }>;
    expect(summaryOutbox.length).toBe(1);
    expect(summaryOutbox[0].local_id).toBe(result.summaryId);
  });

  it('atomicity: if an observation insert throws mid-transaction, NEITHER observation NOR outbox row persists', () => {
    const memoryId = seedSession(db, 'content-atomic', 'memory-atomic');

    // Force a throw inside the txn by hijacking computeObservationContentHash? Simpler:
    // make the second observation violate a NOT NULL constraint indirectly is hard.
    // Instead, drive a throw by passing an observation that makes the lookup fail:
    // we wrap storeObservations and inject a poison by monkeypatching db.prepare.
    const realPrepare = db.prepare.bind(db);
    let obsInsertCount = 0;
    (db as any).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes('INSERT INTO observations')) {
        const realGet = stmt.get.bind(stmt);
        (stmt as any).get = (...args: any[]) => {
          obsInsertCount++;
          if (obsInsertCount === 2) {
            throw new Error('simulated mid-transaction failure');
          }
          return realGet(...args);
        };
      }
      return stmt;
    };

    expect(() =>
      storeObservations(db, memoryId, 'test-project', [
        createObservationInput({ title: 'A' }),
        createObservationInput({ title: 'B' }),
      ])
    ).toThrow('simulated mid-transaction failure');

    (db as any).prepare = realPrepare;

    const obsCount = (db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
    const outboxCount = (db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get() as { n: number }).n;
    expect(obsCount).toBe(0);
    expect(outboxCount).toBe(0);
  });
});

describe('storeObservations + outbox (cloud DISABLED, default)', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    __setCloudEnabledForTest(false);
  });

  afterEach(() => {
    __setCloudEnabledForTest(null);
    db.close();
  });

  it('writes observations and ZERO outbox rows', () => {
    const memoryId = seedSession(db, 'content-disabled', 'memory-disabled');
    const result = storeObservations(db, memoryId, 'test-project', [
      createObservationInput({ title: 'X' }),
      createObservationInput({ title: 'Y' }),
    ]);
    expect(result.observationIds.length).toBe(2);
    const outboxCount = (db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get() as { n: number }).n;
    expect(outboxCount).toBe(0);
  });
});

describe('outbox queue operations', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  it('claimPending flips pending->inflight and RETURNs them; a second claim returns nothing; markDone removes them', () => {
    const now = Date.now();
    enqueueOutbox(db, { kind: 'observation', localId: 1, lane: 'live', createdAtEpoch: now });
    enqueueOutbox(db, { kind: 'observation', localId: 2, lane: 'live', createdAtEpoch: now });

    const claimed = claimPending(db, 'live', 10);
    expect(claimed.length).toBe(2);
    expect(claimed.every(r => r.status === 'inflight')).toBe(true);

    const claimedAgain = claimPending(db, 'live', 10);
    expect(claimedAgain.length).toBe(0);

    markDone(db, claimed.map(r => r.id));
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get() as { n: number }).n;
    expect(remaining).toBe(0);
  });

  it('claimPending respects the lane filter', () => {
    const now = Date.now();
    enqueueOutbox(db, { kind: 'observation', localId: 1, lane: 'live', createdAtEpoch: now });
    enqueueOutbox(db, { kind: 'observation', localId: 2, lane: 'backfill', createdAtEpoch: now });

    const live = claimPending(db, 'live', 10);
    expect(live.length).toBe(1);
    expect(live[0].lane).toBe('live');
  });

  it('markQuarantined, bumpAttempts and countByStatus behave', () => {
    const now = Date.now();
    enqueueOutbox(db, { kind: 'observation', localId: 1, lane: 'live', createdAtEpoch: now });
    enqueueOutbox(db, { kind: 'observation', localId: 2, lane: 'live', createdAtEpoch: now });

    const claimed = claimPending(db, 'live', 1);
    bumpAttempts(db, [claimed[0].id]); // back to pending, attempts=1
    const afterBump = db.prepare('SELECT attempts, status FROM cloud_outbox WHERE id = ?').get(claimed[0].id) as {
      attempts: number;
      status: string;
    };
    expect(afterBump.attempts).toBe(1);
    expect(afterBump.status).toBe('pending');

    markQuarantined(db, [claimed[0].id]);
    const counts = countByStatus(db);
    expect(counts.quarantined).toBe(1);
    expect(counts.pending).toBe(1);
  });

  it('oldestPendingAgeMs returns 0 when empty and a positive number otherwise', () => {
    expect(oldestPendingAgeMs(db)).toBe(0);
    enqueueOutbox(db, { kind: 'observation', localId: 1, lane: 'live', createdAtEpoch: Date.now() - 1000 });
    expect(oldestPendingAgeMs(db)).toBeGreaterThanOrEqual(1000);
  });
});

describe('isolation: outbox module does no network', () => {
  it('the outbox source imports nothing network-related (no fetch/http import)', async () => {
    const src = await Bun.file(
      new URL('../../src/services/cloud/outbox.ts', import.meta.url)
    ).text();
    expect(src).not.toMatch(/\bfetch\b/);
    expect(src).not.toMatch(/from ['"]node:https?['"]/);
    expect(src).not.toMatch(/from ['"]node:net['"]/);
    expect(src).not.toMatch(/import .* from ['"](axios|undici|node-fetch)['"]/);
  });
});

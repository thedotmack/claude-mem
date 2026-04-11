/**
 * Task 9: Observation provenance storage tests
 *
 * Verifies that node, platform, and instance columns are correctly written
 * to the observations table via storeObservation() and storeObservations().
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { storeObservation } from '../../src/services/sqlite/observations/store.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner(db);
  runner.runAllMigrations();
  return db;
}

function seedSession(db: Database, contentSessionId: string, memorySessionId: string, project = 'test-project'): void {
  db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES (?, ?, ?, '2025-01-01T00:00:00Z', 1735689600)`,
    [contentSessionId, memorySessionId, project]
  );
}

function makeObservation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    type: 'discovery',
    title: 'Test observation',
    subtitle: null,
    facts: ['fact1'],
    narrative: 'Test narrative',
    concepts: ['concept1'],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// storeObservation (singular)
// ---------------------------------------------------------------------------

describe('storeObservation — provenance columns', () => {
  let db: Database;

  beforeEach(() => { db = buildDb(); });
  afterEach(() => { db.close(); });

  it('stores node, platform, instance when provided', () => {
    seedSession(db, 'cs-prov-1', 'ms-prov-1');

    const result = storeObservation(
      db,
      'ms-prov-1',
      'test-project',
      makeObservation(),
      1,           // promptNumber
      0,           // discoveryTokens
      undefined,   // overrideTimestampEpoch
      'MSM4M',     // node
      'darwin',    // platform
      'inst-abc',  // instance
      'claude'     // llm_source
    );

    expect(result.id).toBeGreaterThan(0);

    const row = db.query(
      'SELECT node, platform, instance, llm_source FROM observations WHERE id = ?'
    ).get(result.id) as { node: string; platform: string; instance: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.node).toBe('MSM4M');
    expect(row!.platform).toBe('darwin');
    expect(row!.instance).toBe('inst-abc');
    expect(row!.llm_source).toBe('claude');
  });

  it('stores NULL for node, platform, instance when not provided (backward compat)', () => {
    seedSession(db, 'cs-compat-1', 'ms-compat-1');

    const result = storeObservation(
      db,
      'ms-compat-1',
      'test-project',
      makeObservation()
    );

    expect(result.id).toBeGreaterThan(0);

    const row = db.query(
      'SELECT node, platform, instance, llm_source FROM observations WHERE id = ?'
    ).get(result.id) as { node: string | null; platform: string | null; instance: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.node).toBeNull();
    expect(row!.platform).toBeNull();
    expect(row!.instance).toBeNull();
    expect(row!.llm_source).toBeNull();
  });

  it('stores NULL for instance when only node and platform are provided', () => {
    seedSession(db, 'cs-partial-1', 'ms-partial-1');

    const result = storeObservation(
      db,
      'ms-partial-1',
      'test-project',
      makeObservation(),
      undefined,
      0,
      undefined,
      'MBPM4M',
      'darwin'
      // instance omitted
    );

    const row = db.query(
      'SELECT node, platform, instance, llm_source FROM observations WHERE id = ?'
    ).get(result.id) as { node: string; platform: string; instance: string | null } | undefined;

    expect(row!.node).toBe('MBPM4M');
    expect(row!.platform).toBe('darwin');
    expect(row!.instance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storeObservations (batch / transaction)
// ---------------------------------------------------------------------------

describe('storeObservations (transactions) — provenance columns', () => {
  let db: Database;

  beforeEach(() => { db = buildDb(); });
  afterEach(() => { db.close(); });

  it('stores node, platform, instance on all batch observations', () => {
    seedSession(db, 'cs-batch-1', 'ms-batch-1');

    const observations = [
      makeObservation({ title: 'Obs A', narrative: 'Narrative A' }),
      makeObservation({ title: 'Obs B', narrative: 'Narrative B' }),
    ];

    const result = storeObservations(
      db,
      'ms-batch-1',
      'test-project',
      observations,
      null,        // summary
      1,           // promptNumber
      0,           // discoveryTokens
      undefined,   // overrideTimestampEpoch
      'MSM3U',     // node
      'darwin',    // platform
      'inst-xyz',  // instance
      'claude'     // llmSource
    );

    expect(result.observationIds).toHaveLength(2);

    for (const id of result.observationIds) {
      const row = db.query(
        'SELECT node, platform, instance, llm_source FROM observations WHERE id = ?'
      ).get(id) as { node: string; platform: string; instance: string; llm_source: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.node).toBe('MSM3U');
      expect(row!.platform).toBe('darwin');
      expect(row!.instance).toBe('inst-xyz');
      expect(row!.llm_source).toBe('claude');
    }
  });

  it('stores NULL provenance when not provided (backward compat)', () => {
    seedSession(db, 'cs-batch-compat', 'ms-batch-compat');

    const result = storeObservations(
      db,
      'ms-batch-compat',
      'test-project',
      [makeObservation({ title: 'No prov', narrative: 'No provenance test' })],
      null
    );

    expect(result.observationIds).toHaveLength(1);

    const row = db.query(
      'SELECT node, platform, instance, llm_source FROM observations WHERE id = ?'
    ).get(result.observationIds[0]) as { node: string | null; platform: string | null; instance: string | null } | undefined;

    expect(row!.node).toBeNull();
    expect(row!.platform).toBeNull();
    expect(row!.instance).toBeNull();
  });
});

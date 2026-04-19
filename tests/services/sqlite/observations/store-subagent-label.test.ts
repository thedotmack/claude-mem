/**
 * Tests for storeObservation subagent labeling (agent_type, agent_id).
 *
 * Validates:
 * 1. Rows carry agent_type / agent_id when set on ObservationInput.
 * 2. Omitted subagent fields store as NULL (main-session rows).
 * 3. Dedup is intentionally UNAFFECTED by agent_type — the content hash
 *    covers (memory_session_id, title, narrative) only, so two observations
 *    with the same semantic identity but different originating subagents
 *    dedup to the same row. This preserves stable observation identity
 *    across main-session and subagent contexts and is the documented
 *    intended behavior per Phase 4 anti-pattern guard in the plan.
 *
 * Sources:
 * - Store:  src/services/sqlite/observations/store.ts
 * - Types:  src/services/sqlite/observations/types.ts
 * - Test pattern: tests/sqlite/observations.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../../src/services/sqlite/Database.js';
import { storeObservation } from '../../../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('storeObservation — subagent labeling', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Subtitle',
      facts: ['fact1'],
      narrative: 'Narrative body',
      concepts: ['concept1'],
      files_read: ['/path/to/file1.ts'],
      files_modified: [],
      ...overrides,
    };
  }

  function createSessionWithMemoryId(
    contentSessionId: string,
    memorySessionId: string,
    project = 'test-project'
  ): string {
    const sessionId = createSDKSession(db, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(db, sessionId, memorySessionId);
    return memorySessionId;
  }

  it('stores agent_type and agent_id when provided', () => {
    const memorySessionId = createSessionWithMemoryId('content-sub-1', 'mem-sub-1');
    const input = createObservationInput({
      agent_type: 'Explore',
      agent_id: 'agent-abc',
    });

    const result = storeObservation(db, memorySessionId, 'test-project', input);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(result.id) as { agent_type: string | null; agent_id: string | null };

    expect(row).not.toBeNull();
    expect(row.agent_type).toBe('Explore');
    expect(row.agent_id).toBe('agent-abc');
  });

  it('stores NULL for agent_type and agent_id when fields are omitted (main-session row)', () => {
    const memorySessionId = createSessionWithMemoryId('content-main-1', 'mem-main-1');
    const input = createObservationInput();
    // input has no agent_type / agent_id

    const result = storeObservation(db, memorySessionId, 'test-project', input);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(result.id) as { agent_type: string | null; agent_id: string | null };

    expect(row).not.toBeNull();
    expect(row.agent_type).toBeNull();
    expect(row.agent_id).toBeNull();
  });

  it('stores agent_type only when agent_id is absent', () => {
    const memorySessionId = createSessionWithMemoryId('content-partial-1', 'mem-partial-1');
    const input = createObservationInput({
      agent_type: 'Plan',
      // agent_id intentionally omitted
    });

    const result = storeObservation(db, memorySessionId, 'test-project', input);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(result.id) as { agent_type: string | null; agent_id: string | null };

    expect(row.agent_type).toBe('Plan');
    expect(row.agent_id).toBeNull();
  });

  it('dedup is NOT affected by agent fields — second insert with different agent_type returns existing id', () => {
    // INTENDED BEHAVIOR (per plan Phase 4 anti-pattern guard):
    //   The content hash covers (memory_session_id, title, narrative) only.
    //   Two observations with identical title + narrative but different
    //   agent_type must dedup to the same row so observation identity is
    //   stable across main-session and subagent contexts.
    const memorySessionId = createSessionWithMemoryId('content-dedup-1', 'mem-dedup-1');

    const first = storeObservation(
      db,
      memorySessionId,
      'test-project',
      createObservationInput({
        title: 'Identical Title',
        narrative: 'Identical narrative body.',
        agent_type: 'Explore',
        agent_id: 'agent-first',
      })
    );

    const second = storeObservation(
      db,
      memorySessionId,
      'test-project',
      createObservationInput({
        title: 'Identical Title',
        narrative: 'Identical narrative body.',
        agent_type: 'Plan',
        agent_id: 'agent-second',
      })
    );

    // Second insert is deduped → same id, no new row, original agent fields preserved.
    expect(second.id).toBe(first.id);

    const rowCount = db
      .prepare('SELECT COUNT(*) as n FROM observations WHERE memory_session_id = ?')
      .get(memorySessionId) as { n: number };
    expect(rowCount.n).toBe(1);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(first.id) as { agent_type: string | null; agent_id: string | null };
    expect(row.agent_type).toBe('Explore');
    expect(row.agent_id).toBe('agent-first');
  });
});

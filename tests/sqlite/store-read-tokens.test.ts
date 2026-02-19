/**
 * Storage test: read_tokens populated at insert time
 *
 * Verifies that when observations are stored via storeObservation(),
 * the read_tokens column is populated with the correct token estimate.
 *
 * Implementation note: facts and concepts are JSON-serialized arrays
 * before storage, so their token estimate is based on the JSON string
 * length (e.g. [] → "[]" → 2 chars → 1 token). This is consistent
 * with the migration backfill, which uses LENGTH(facts) on the stored
 * JSON column value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeObservation,
  getObservationById,
} from '../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from '../../src/services/sqlite/sqlite-compat.js';

// Helper: compute the expected read_tokens for a given observation,
// mirroring what storeObservation + estimateReadTokens does.
// Each field is individually ceiling-divided by 4 and then summed —
// matching estimateTokens(field) which calls Math.ceil(text.length / 4).
function ceilDiv4(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function expectedReadTokens(observation: ObservationInput): number {
  return (
    ceilDiv4(observation.narrative) +
    ceilDiv4(observation.title) +
    ceilDiv4(JSON.stringify(observation.facts)) +
    ceilDiv4(JSON.stringify(observation.concepts))
  );
}

describe('storeObservation — read_tokens populated at insert time', () => {
  let db: Database;
  let memorySessionId: string;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    // Create a session so FK constraints pass
    const sessionId = createSDKSession(db, 'content-session-rt', 'test-project', 'test prompt');
    memorySessionId = 'memory-session-rt';
    updateMemorySessionId(db, sessionId, memorySessionId);
  });

  afterEach(() => {
    db.close();
  });

  it('sets read_tokens to a positive value even with empty facts/concepts (serialized as "[]")', () => {
    // facts: [] → "[]" (2 chars), concepts: [] → "[]" (2 chars)
    // total serialized content: 4 chars → ceil(4/4) = 1 token
    const observation: ObservationInput = {
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservation(db, memorySessionId, 'test-project', observation);
    const stored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(result.id) as { read_tokens: number };

    expect(stored.read_tokens).toBe(expectedReadTokens(observation));
  });

  it('sets read_tokens based on narrative length plus serialized empty arrays', () => {
    // narrative: 8 chars, facts: "[]" 2 chars, concepts: "[]" 2 chars → total 12 → 3 tokens
    const observation: ObservationInput = {
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: [],
      narrative: '12345678',
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservation(db, memorySessionId, 'test-project', observation);
    const stored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(result.id) as { read_tokens: number };

    expect(stored.read_tokens).toBe(expectedReadTokens(observation));
  });

  it('sets read_tokens based on title length plus serialized empty arrays', () => {
    // title: 4 chars, facts: "[]" 2 chars, concepts: "[]" 2 chars → total 8 → 2 tokens
    const observation: ObservationInput = {
      type: 'discovery',
      title: 'abcd',
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservation(db, memorySessionId, 'test-project', observation);
    const stored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(result.id) as { read_tokens: number };

    expect(stored.read_tokens).toBe(expectedReadTokens(observation));
  });

  it('sums read_tokens across title, narrative, and serialized facts/concepts', () => {
    // title: 4 chars
    // narrative: 8 chars
    // facts: ["ab","cd"] → JSON.stringify = '["ab","cd"]' = 11 chars
    // concepts: ["ef"] → JSON.stringify = '["ef"]' = 6 chars
    // total: 29 chars → ceil(29/4) = 8 tokens
    const observation: ObservationInput = {
      type: 'feature',
      title: 'abcd',
      subtitle: null,
      facts: ['ab', 'cd'],
      narrative: '12345678',
      concepts: ['ef'],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservation(db, memorySessionId, 'test-project', observation);
    const stored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(result.id) as { read_tokens: number };

    expect(stored.read_tokens).toBe(expectedReadTokens(observation));
  });

  it('sets read_tokens correctly for a realistic observation', () => {
    const narrative = 'Implemented read_tokens column tracking for token analytics dashboard.';
    const title = 'Add read_tokens column';
    const observation: ObservationInput = {
      type: 'feature',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservation(db, memorySessionId, 'test-project', observation);
    const stored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(result.id) as { read_tokens: number };

    expect(stored.read_tokens).toBe(expectedReadTokens(observation));
  });

  it('increases read_tokens proportionally for longer content', () => {
    const shortObs: ObservationInput = {
      type: 'discovery',
      title: 'short',
      subtitle: null,
      facts: [],
      narrative: 'short narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const longObs: ObservationInput = {
      type: 'discovery',
      title: 'A much longer title with more words',
      subtitle: null,
      facts: [],
      narrative: 'A'.repeat(200),
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const shortResult = storeObservation(db, memorySessionId, 'test-project', shortObs);
    const longResult = storeObservation(db, memorySessionId, 'test-project', longObs);

    const shortStored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(shortResult.id) as { read_tokens: number };
    const longStored = db.prepare('SELECT read_tokens FROM observations WHERE id = ?').get(longResult.id) as { read_tokens: number };

    expect(longStored.read_tokens).toBeGreaterThan(shortStored.read_tokens);
  });

  it('getObservationById returns the stored read_tokens value', () => {
    const observation: ObservationInput = {
      type: 'discovery',
      title: 'Test title',
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservation(db, memorySessionId, 'test-project', observation);

    // getObservationById should include read_tokens in the returned record
    const stored = getObservationById(db, result.id);
    expect(stored).not.toBeNull();
    const readTokens = (stored as NonNullable<typeof stored> & { read_tokens: number }).read_tokens;
    expect(readTokens).toBe(expectedReadTokens(observation));
  });
});

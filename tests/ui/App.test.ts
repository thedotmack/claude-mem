/**
 * Tests for App-level pure functions
 *
 * Tests the detectActiveSessionId function that identifies active (unsummarized)
 * sessions from SSE data. This is a pure function — no React/DOM needed.
 */

import { describe, it, expect } from 'vitest';
import type { Observation, Summary } from '../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = 'test-project';

/** Fixed epoch to avoid non-deterministic Date.now() in tests */
const FIXED_EPOCH = 1700000000000;

function makeObservation(id: number, sessionId: string): Observation {
  return {
    id,
    memory_session_id: sessionId,
    project: PROJECT,
    type: 'discovery',
    title: `Observation ${String(id)}`,
    subtitle: null,
    narrative: null,
    text: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    created_at: new Date(FIXED_EPOCH).toISOString(),
    created_at_epoch: FIXED_EPOCH - id * 1000,
  };
}

function makeSummary(id: number, sessionId: string, memorySessionId?: string): Summary {
  return {
    id,
    session_id: sessionId,
    ...(memorySessionId ? { memory_session_id: memorySessionId } : {}),
    project: PROJECT,
    request: `Session ${String(id)}`,
    created_at_epoch: FIXED_EPOCH - id * 1000,
  };
}

// ---------------------------------------------------------------------------
// detectActiveSessionId tests
// ---------------------------------------------------------------------------

describe('detectActiveSessionId', () => {
  it('returns null when observations array is empty', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const result = detectActiveSessionId([], []);
    expect(result).toBeNull();
  });

  it('returns the session_id of an unsummarized observation', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const observations = [makeObservation(1, 'active-session')];
    const summaries: Summary[] = [];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBe('active-session');
  });

  it('returns null when all observations have matching summaries', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const observations = [
      makeObservation(1, 'session-a'),
      makeObservation(2, 'session-b'),
    ];
    const summaries = [
      makeSummary(1, 'session-a'),
      makeSummary(2, 'session-b'),
    ];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBeNull();
  });

  it('finds unsummarized session even when first observation has a summary', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    // First observation has a summary, second does not
    const observations = [
      makeObservation(1, 'summarized-session'),
      makeObservation(2, 'active-session'),
    ];
    const summaries = [makeSummary(1, 'summarized-session')];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBe('active-session');
  });

  it('returns the first unsummarized session_id found (scan order)', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const observations = [
      makeObservation(1, 'active-a'),
      makeObservation(2, 'active-b'),
    ];
    const summaries: Summary[] = [];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBe('active-a');
  });

  it('handles duplicate observations for the same active session', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const observations = [
      makeObservation(1, 'active-session'),
      makeObservation(2, 'active-session'),
      makeObservation(3, 'active-session'),
    ];
    const summaries: Summary[] = [];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBe('active-session');
  });

  it('handles mixed summarized and unsummarized observations with SSE reorders', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    // Simulate SSE reconnect reorder: summarized obs interleaved with active ones
    const observations = [
      makeObservation(1, 'session-old'),
      makeObservation(2, 'session-active'),
      makeObservation(3, 'session-old'),
      makeObservation(4, 'session-active'),
    ];
    const summaries = [makeSummary(1, 'session-old')];

    const result = detectActiveSessionId(observations, summaries);
    // Should find session-active even though first obs is summarized
    expect(result).toBe('session-active');
  });

  it('returns first unsummarized session when summaries array is empty', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const observations = [
      makeObservation(1, 'session-x'),
      makeObservation(2, 'session-y'),
    ];
    // Empty summaries — all sessions are "active"
    const result = detectActiveSessionId(observations, []);
    expect(result).toBe('session-x');
  });

  it('matches via memory_session_id when session_id differs (content vs memory ID)', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    // Observations use memory_session_id; summaries may return content_session_id as session_id
    const observations = [
      makeObservation(1, 'memory-id-abc'),
    ];
    const summaries = [
      // session_id is content_session_id (different!), memory_session_id matches the observation
      makeSummary(1, 'content-id-xyz', 'memory-id-abc'),
    ];

    const result = detectActiveSessionId(observations, summaries);
    // Should detect as summarized (NOT active) because memory_session_id matches
    expect(result).toBeNull();
  });

  it('falls back to session_id when memory_session_id is not present on summary', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    const observations = [makeObservation(1, 'session-a')];
    // Old-format summary without memory_session_id — falls back to session_id comparison
    const summaries = [makeSummary(1, 'session-a')];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBeNull();
  });

  it('uses Set for efficient lookups (many summaries)', async () => {
    const { detectActiveSessionId } = await import('../../src/ui/viewer/App.js');
    // Create many summaries to verify Set-based approach works at scale
    const summaries = Array.from({ length: 100 }, (_, i) => makeSummary(i, `session-${String(i)}`));
    const observations = [
      ...Array.from({ length: 50 }, (_, i) => makeObservation(i, `session-${String(i)}`)),
      makeObservation(999, 'active-session'),
    ];

    const result = detectActiveSessionId(observations, summaries);
    expect(result).toBe('active-session');
  });
});

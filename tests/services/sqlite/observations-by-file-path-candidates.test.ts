// #2691 — Path inconsistency between PreToolUse:Read and PostToolUse broke
// context injection. PostToolUse stores whatever path form the observer
// recorded (often the absolute tool-input path), while PreToolUse:Read queried
// ONLY the cwd-relative form, so the exact-match lookup never matched.
// getObservationsByFilePath now accepts multiple candidate path forms and
// matches an observation whose files_read/files_modified contain ANY of them,
// yielding a consistent key across both handlers.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';

describe('getObservationsByFilePath — multi-candidate path matching (#2691)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function seedObservationWithReadPath(readPath: string, sessionSuffix: string): number {
    const sdkId = store.createSDKSession(`content-${sessionSuffix}`, 'proj', 'prompt');
    store.updateMemorySessionId(sdkId, `session-${sessionSuffix}`);
    const result = store.storeObservations(
      `session-${sessionSuffix}`,
      'proj',
      [{
        type: 'discovery',
        title: `touched ${readPath}`,
        subtitle: null,
        facts: ['fact'],
        narrative: null,
        concepts: [],
        files_read: [readPath],
        files_modified: [],
      }],
      null,
      0,
      0,
      1_700_000_000_000,
    );
    return result.observationIds[0];
  }

  it('matches an observation stored under an ABSOLUTE path when querying multiple candidate forms', () => {
    const absolutePath = '/Users/dev/proj/src/services/foo.ts';
    const relativePath = 'src/services/foo.ts';
    const id = seedObservationWithReadPath(absolutePath, 'abs');

    // PreToolUse:Read sends both the absolute and the relative candidate forms.
    const matches = getObservationsByFilePath(store.db, [absolutePath, relativePath]);
    expect(matches.map(o => o.id)).toContain(id);
  });

  it('matches an observation stored under a RELATIVE path when querying multiple candidate forms', () => {
    const absolutePath = '/Users/dev/proj/src/services/bar.ts';
    const relativePath = 'src/services/bar.ts';
    const id = seedObservationWithReadPath(relativePath, 'rel');

    const matches = getObservationsByFilePath(store.db, [absolutePath, relativePath]);
    expect(matches.map(o => o.id)).toContain(id);
  });

  it('regression: the OLD single relative-path query would NOT match absolute storage', () => {
    const absolutePath = '/Users/dev/proj/src/services/baz.ts';
    const relativePath = 'src/services/baz.ts';
    const id = seedObservationWithReadPath(absolutePath, 'old');

    // Old behavior (single relative path) — no match. Demonstrates the bug.
    const relativeOnly = getObservationsByFilePath(store.db, relativePath);
    expect(relativeOnly.map(o => o.id)).not.toContain(id);

    // New behavior (both forms) — match.
    const both = getObservationsByFilePath(store.db, [absolutePath, relativePath]);
    expect(both.map(o => o.id)).toContain(id);
  });

  it('backward compatible: a single string path still works', () => {
    const absolutePath = '/Users/dev/proj/src/single.ts';
    const id = seedObservationWithReadPath(absolutePath, 'single');
    const matches = getObservationsByFilePath(store.db, absolutePath);
    expect(matches.map(o => o.id)).toContain(id);
  });
});

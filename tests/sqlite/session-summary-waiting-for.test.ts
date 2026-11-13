import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { LATEST_SCHEMA_VERSION } from '../../src/services/sqlite/connection.js';
import { WAITING_FOR, type WaitingFor } from '../../src/services/work-view/waiting-for.mjs';

const summary = (waiting_for?: WaitingFor | null) => ({
  request: 'Ship the release cards', investigated: '', learned: '', completed: 'Built the cards', next_steps: '', notes: null,
  ...(waiting_for === undefined ? {} : { waiting_for }),
});

function session(store: SessionStore, memorySessionId: string): string {
  store.updateMemorySessionId(store.createSDKSession(`content-${memorySessionId}`, 'project', 'prompt'), memorySessionId);
  return memorySessionId;
}

const waitingFor = (store: SessionStore, id: number | null) =>
  (store.db.query('SELECT waiting_for FROM session_summaries WHERE id = ?').get(id) as { waiting_for: string | null }).waiting_for;

describe('what a summary says its turn waits for', () => {
  it('is added to a database created before the column, leaving old summaries null and the schema version alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-waiting-for-'));
    const path = join(dir, 'db.sqlite');
    let store = new SessionStore(path, { syncOpsEnabled: false });
    try {
      const old = store.storeSummary(session(store, 'mem-old'), 'project', summary()).id;
      store.db.run('ALTER TABLE session_summaries DROP COLUMN waiting_for');
      store.close();

      store = new SessionStore(path, { syncOpsEnabled: false });
      expect(waitingFor(store, old)).toBeNull();
      expect(store.getSummaryForSession('mem-old')?.completed).toBe('Built the cards');
      const added = store.storeSummary(session(store, 'mem-new'), 'project', summary('approval')).id;
      expect(waitingFor(store, added)).toBe('approval');
      const versions = store.db.query('SELECT MAX(version) AS version FROM schema_versions').get() as { version: number };
      expect(versions.version).toBe(LATEST_SCHEMA_VERSION);
      store.close();

      store = new SessionStore(path, { syncOpsEnabled: false });
      expect(waitingFor(store, added)).toBe('approval');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('round-trips every value through both store paths, and stores null when the summary did not say', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      for (const value of WAITING_FOR) {
        expect(waitingFor(store, store.storeSummary(session(store, `mem-a-${value}`), 'project', summary(value)).id)).toBe(value);
        expect(waitingFor(store, store.storeObservations(session(store, `mem-b-${value}`), 'project', [], summary(value), 1).summaryId)).toBe(value);
      }
      expect(waitingFor(store, store.storeSummary(session(store, 'mem-unsaid'), 'project', summary()).id)).toBeNull();
      expect(waitingFor(store, store.storeObservations(session(store, 'mem-null'), 'project', [], summary(null), 1).summaryId)).toBeNull();
    } finally { store.close(); }
  });

  it('a later stop in the same prompt replaces it, an unsaid value included', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const mem = session(store, 'mem-merge');
      const first = store.storeObservations(mem, 'project', [], summary('answer'), 3).summaryId;
      expect(store.storeObservations(mem, 'project', [], summary('nothing'), 3).summaryId).toBe(first);
      expect(waitingFor(store, first)).toBe('nothing');
      store.storeObservations(mem, 'project', [], summary(), 3);
      expect(waitingFor(store, first)).toBeNull();
    } finally { store.close(); }
  });
});

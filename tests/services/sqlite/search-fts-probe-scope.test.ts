import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

for (const keepProbeConnectionOpen of [false, true]) {
  describe(keepProbeConnectionOpen ? 'concurrent FTS capability probe' : 'persisted interrupted FTS capability probe', () => {
    it('keeps valid full-text search available on a second connection', () => {
      const directory = mkdtempSync(join(tmpdir(), 'claude-mem-fts-probe-'));
      const path = join(directory, 'memory.db');
      let producer: SessionStore | undefined;
      let consumer: SessionStore | undefined;
      try {
        producer = new SessionStore(path);
        new SessionSearch(producer.db);
        const session = producer.createSDKSession('probe-session', 'probe-project', 'prompt');
        producer.ensureMemorySessionIdRegistered(session, 'probe-memory');
        producer.storeObservation('probe-memory', 'probe-project', {
          type: 'discovery', title: 'indexed searchable finding', subtitle: null,
          narrative: 'capability control', facts: [], concepts: [], files_read: [], files_modified: [],
        }, 1);

        // This is the actual producer's intermediate state between CREATE and DROP.
        producer.db.run('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
        if (!keepProbeConnectionOpen) {
          producer.close();
          producer = undefined;
        }
        consumer = new SessionStore(path);
        const search = new SessionSearch(consumer.db);
        expect(search.searchObservations('indexed searchable', { project: 'probe-project' })).toHaveLength(1);
        expect(consumer.db.query("SELECT name FROM sqlite_master WHERE name = '_fts5_probe'").get()).not.toBeNull();
        expect(consumer.db.query("SELECT name FROM sqlite_temp_master WHERE name = '_fts5_probe'").get()).toBeNull();
      } finally {
        consumer?.close();
        producer?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
}

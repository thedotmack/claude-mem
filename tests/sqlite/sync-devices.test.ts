import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  labelOriginDevices,
  originDevicePrefix,
  readSyncDeviceNames,
  saveSyncDeviceNames,
} from '../../src/services/sqlite/sync-devices.js';
import { queryObservationsMulti, querySummariesMulti } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 20,
  fullObservationCount: 3,
  sessionCount: 20,
  showReadTokens: true,
  showWorkTokens: true,
  showSavingsAmount: true,
  showSavingsPercent: true,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['origin']),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
  mainAgentOnly: true,
};

function seed(store: SessionStore, memorySessionId: string, title: string, createdAtEpoch: number): number {
  const sessionDbId = store.createSDKSession(`content-${memorySessionId}`, 'origin-project', 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  const { id } = store.storeObservation(
    memorySessionId,
    'origin-project',
    { type: 'discovery', title, subtitle: null, facts: [], narrative: 'n', concepts: ['origin'], files_read: [], files_modified: [] },
    1,
    0,
    createdAtEpoch,
  );
  store.storeSummary(
    memorySessionId,
    'origin-project',
    { request: `${title} request`, investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null },
    1,
    0,
    createdAtEpoch,
  );
  return id;
}

describe('sync device names', () => {
  it('saves hub names, keeps one line per name, and applies a rename', () => {
    const store = new SessionStore(':memory:');
    try {
      saveSyncDeviceNames(store.db, [
        { deviceId: 'dev-a', name: '  build\nbox [prod]  ' },
        { deviceId: 'dev-b', name: '   ' },
        { deviceId: '', name: 'no id' },
      ]);
      expect([...readSyncDeviceNames(store.db)]).toEqual([['dev-a', 'build box prod']]);

      saveSyncDeviceNames(store.db, [{ deviceId: 'dev-a', name: 'Desk Mac' }]);
      expect(readSyncDeviceNames(store.db).get('dev-a')).toBe('Desk Mac');
    } finally {
      store.close();
    }
  });

  it('reads no names from a database that predates the table', () => {
    const db = new Database(':memory:');
    try {
      expect(readSyncDeviceNames(db).size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('labels replica rows with the device name or a short id, and leaves native rows unmarked', () => {
    const store = new SessionStore(':memory:');
    try {
      saveSyncDeviceNames(store.db, [{ deviceId: 'dev-named', name: 'vcit01' }]);
      const rows = labelOriginDevices(
        store.db,
        [{ origin_device_id: null }, { origin_device_id: 'dev-named' }, { origin_device_id: '0123456789abcdef' }],
      );
      expect(rows.map(row => row.origin_device)).toEqual([undefined, 'vcit01', '01234567']);
      expect(rows.map(originDevicePrefix)).toEqual(['', '[vcit01] ', '[01234567] ']);
    } finally {
      store.close();
    }
  });

  it('gives context and get_observations rows the origin device of a pulled row', () => {
    const store = new SessionStore(':memory:');
    try {
      const nativeId = seed(store, 'native-memory', 'NATIVE_OBS', 1_700_000_000_000);
      const replicaId = seed(store, 'replica-memory', 'REPLICA_OBS', 1_700_000_001_000);
      store.db.run("UPDATE observations SET origin_device_id = 'dev-laptop' WHERE id = ?", [replicaId]);
      store.db.run("UPDATE session_summaries SET origin_device_id = 'dev-laptop' WHERE memory_session_id = 'replica-memory'");
      saveSyncDeviceNames(store.db, [{ deviceId: 'dev-laptop', name: 'laptop' }]);

      const observations = labelOriginDevices(store.db, queryObservationsMulti(store, ['origin-project'], config));
      expect(observations.map(obs => [obs.title, obs.origin_device])).toEqual([
        ['REPLICA_OBS', 'laptop'],
        ['NATIVE_OBS', undefined],
      ]);
      const summaries = labelOriginDevices(store.db, querySummariesMulti(store, ['origin-project'], config));
      expect(summaries.map(summary => summary.origin_device)).toEqual(['laptop', undefined]);

      const fetched = labelOriginDevices(store.db, store.getObservationsByIds([nativeId, replicaId], { orderBy: 'relevance' }));
      expect(fetched.map(obs => obs.origin_device)).toEqual([undefined, 'laptop']);
    } finally {
      store.close();
    }
  });
});

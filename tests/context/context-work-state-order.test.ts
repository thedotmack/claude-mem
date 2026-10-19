import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('work-state read ordering', () => {
  it('orders native and synced writes using the current local device identity', () => {
    const store = new SessionStore(':memory:');
    try {
      store.appendWorkStateEntry({ project: 'app', listName: 'tasks', fields: { label: 'native' }, createdAtEpoch: 1_000 });
      const remoteId = store.appendWorkStateEntry({ project: 'app', listName: 'tasks', fields: { label: 'remote' }, createdAtEpoch: 1_000 });
      const statement = store.db.prepare('UPDATE work_state_entries SET origin_device_id = ?, origin_local_id = ? WHERE id = ?');
      try {
        statement.run('device-a', '7', remoteId);
      } finally {
        statement.finalize();
      }
      store.setLocalSyncDeviceId('device-z');
      expect(store.getWorkStateEntries(['app']).map(entry => entry.fields.label)).toEqual(['remote', 'native']);
    } finally {
      store.close();
    }
  });
});

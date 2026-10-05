import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

it('keeps a linked tool use discoverable under its observation memory identity after a session rekey', () => {
  const store = new SessionStore(':memory:');
  try {
    const sid = store.createSDKSession('rekey-content', 'rekey-project', 'Read the file');
    store.updateMemorySessionId(sid, 'first-memory');
    const toolId = store.upsertToolUse({ toolUseId: 'read-file', contentSessionId: 'rekey-content',
      sessionDbId: sid, memorySessionId: 'first-memory', project: 'rekey-project',
      toolName: 'Read', toolInput: '{"file_path":"src/file.ts"}', toolResponse: 'File contents' });
    const otherSid = store.createSDKSession('other-content', 'rekey-project', 'Other session');
    store.updateMemorySessionId(otherSid, 'other-memory');
    const otherToolId = store.upsertToolUse({ toolUseId: 'read-file', contentSessionId: 'other-content',
      sessionDbId: otherSid, memorySessionId: 'other-memory', project: 'rekey-project', toolName: 'Read' });
    const observation = store.storeObservation('first-memory', 'rekey-project', {
      type: 'discovery', title: 'Read file contents', subtitle: null, narrative: 'Read the file',
      facts: [], concepts: [], files_read: ['src/file.ts'], files_modified: [],
    }, 1);
    store.linkToolUsesToObservation({ contentSessionId: 'rekey-content', toolUseIds: ['read-file'],
      observationId: observation.id, memorySessionId: 'first-memory' });
    expect(store.queryToolUses({ memorySessionId: 'first-memory' }).map(row => row.id)).toEqual([toolId!]);
    store.updateMemorySessionId(sid, 'new-provider-memory');
    expect(store.getObservationById(observation.id)?.memory_session_id).toBe('new-provider-memory');
    expect(store.queryToolUses({ memorySessionId: 'new-provider-memory' }).map(row => row.id)).toEqual([toolId!]);
    expect(store.queryToolUses({ memorySessionId: 'first-memory' })).toEqual([]);
    expect(store.queryToolUses({ memorySessionId: 'other-memory' }).map(row => row.id)).toEqual([otherToolId!]);
  } finally {
    store.close();
  }
});

it('rolls back the parent and observation cascade if the receipt update fails', () => {
  const store = new SessionStore(':memory:');
  try {
    const sid = store.createSDKSession('rollback-content', 'rekey-project', 'Read the file');
    store.updateMemorySessionId(sid, 'first-memory');
    store.upsertToolUse({ toolUseId: 'read-file', contentSessionId: 'rollback-content',
      sessionDbId: sid, memorySessionId: 'first-memory', project: 'rekey-project', toolName: 'Read' });
    const observation = store.storeObservation('first-memory', 'rekey-project', {
      type: 'discovery', title: 'Read file', subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1);
    store.db.run(`CREATE TRIGGER reject_receipt_rekey BEFORE UPDATE OF memory_session_id ON tool_uses
      BEGIN SELECT RAISE(ABORT, 'owned receipt failure'); END`);
    expect(() => store.updateMemorySessionId(sid, 'new-provider-memory')).toThrow('owned receipt failure');
    expect(store.getSessionById(sid).memory_session_id).toBe('first-memory');
    expect(store.getObservationById(observation.id)?.memory_session_id).toBe('first-memory');
    expect(store.queryToolUses({ memorySessionId: 'first-memory' })).toHaveLength(1);
    expect(store.queryToolUses({ memorySessionId: 'new-provider-memory' })).toEqual([]);
  } finally {
    store.close();
  }
});

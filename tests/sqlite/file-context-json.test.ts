import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../src/services/sqlite/observations/get.js';
it('keeps valid file context readable beside malformed legacy imported JSON', () => {
  const s = new SessionStore(':memory:');
  try {
    const id = s.createSDKSession('content', 'app', 'prompt');
    s.updateMemorySessionId(id, 'memory');
    const row = {
      memory_session_id: 'memory',
      project: 'app',
      text: null,
      type: 'discovery',
      title: 'malformed',
      subtitle: null,
      facts: null,
      narrative: null,
      concepts: null,
      files_read: '[invalid',
      files_modified: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1000).toISOString(),
      created_at_epoch: 1000,
    };
    s.importObservation(row);
    const good = s.importObservation({
      ...row,
      title: 'good',
      files_read: ' ["file.ts"] ',
      created_at_epoch: 2000,
    });
    const object = s.importObservation({
      ...row,
      title: 'object',
      files_read: '{"unexpected":"file.ts"}',
      created_at_epoch: 3000,
    });
    expect(
      getObservationsByFilePath(s.db, 'file.ts', { projects: ['app'] }).map((r) => r.id)
    ).toEqual([good.id]);
    expect(getObservationsByFilePath(s.db, 'file.ts', { projects: ['other'] })).toEqual([]);
    expect(getObservationsByFilePath(s.db, 'absent.ts')).toEqual([]);
  } finally {
    s.close();
  }
});

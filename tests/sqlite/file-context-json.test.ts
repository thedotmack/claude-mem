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

it('isolates malformed modified-only metadata and searches whitespace/escaped arrays', () => {
  const store = new SessionStore(':memory:');
  try {
    const id = store.createSDKSession('modified-content', 'app', 'prompt');
    store.updateMemorySessionId(id, 'modified-memory');
    const row = {
      memory_session_id: 'modified-memory', project: 'app', text: null,
      type: 'discovery', title: 'invalid', subtitle: null, facts: null,
      narrative: null, concepts: null, files_read: null, files_modified: null,
      prompt_number: 1, discovery_tokens: 0,
      created_at: new Date(1000).toISOString(), created_at_epoch: 1000,
    };
    const malformed = ['[invalid', '{"path":"file.ts"}', '"file.ts"', 'null', 'true', '42', '', ' \t[invalid', ' \n{"path":"file.ts"}'];
    // A timestamp per fixture keeps all nine as separate rows whatever the
    // import's replay match is, so every malformed value is really queried.
    for (const [index, metadata] of malformed.entries()) {
      expect(store.importObservation({ ...row, files_modified: metadata, created_at_epoch: 1000 + index }).imported)
        .toBe(true);
    }
    const stored = store.db
      .query("SELECT files_modified FROM observations WHERE title = 'invalid' ORDER BY created_at_epoch")
      .all() as Array<{ files_modified: string }>;
    expect(stored.map(r => r.files_modified)).toEqual(malformed);
    const good = store.importObservation({ ...row, title: 'modified',
      files_modified: ' \t\r\n["file.ts"] \n', created_at_epoch: 2000 });
    const escapedPath = 'quoted"%_\\file.ts';
    const escaped = store.importObservation({ ...row, title: 'escaped',
      files_modified: JSON.stringify([escapedPath]), created_at_epoch: 3000 });
    const unicode = store.importObservation({ ...row, title: 'unicode',
      files_modified: '["f\\u0069le.ts"]', created_at_epoch: 4000 });
    expect(getObservationsByFilePath(store.db, 'file.ts', { projects: ['app'] }).map(r => r.id))
      .toEqual([unicode.id, good.id]);
    expect(getObservationsByFilePath(store.db, escapedPath).map(r => r.id)).toEqual([escaped.id]);
    const padded = [' ', '\t', '\r', '\n'].map((prefix, index) =>
      store.importObservation({ ...row, title: 'padded', files_modified: prefix + '["padded.ts"]',
        created_at_epoch: 5000 + index }));
    expect(getObservationsByFilePath(store.db, 'padded.ts').map(r => r.id))
      .toEqual(padded.map(result => result.id).reverse());
    expect(getObservationsByFilePath(store.db, 'file.ts', { projects: ['other'] })).toEqual([]);
    expect(getObservationsByFilePath(store.db, 'absent.ts')).toEqual([]);
  } finally {
    store.close();
  }
});

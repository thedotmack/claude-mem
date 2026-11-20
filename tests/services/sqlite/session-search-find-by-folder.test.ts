import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// Folder lookups back the folder CLAUDE.md files (#3116). Stored paths are
// absolute when they come from a tool's input and project-relative when they
// come from the observer's output, so an absolute folder must find both.
describe('SessionSearch.findByFile for a folder', () => {
  const project = 'folder-project';
  const root = '/home/user/folder-project';
  let store: SessionStore;
  let search: SessionSearch;

  function session(memorySessionId: string): void {
    const sdkId = store.createSDKSession(`content-${memorySessionId}`, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
  }

  function seedObservation(memorySessionId: string, title: string, filesRead: string[], filesModified: string[] = []): number {
    session(memorySessionId);
    return store.storeObservation(memorySessionId, project, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: `${title} narrative`,
      concepts: [],
      files_read: filesRead,
      files_modified: filesModified,
    }, 1).id;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it('finds direct children stored absolute or project-relative under an absolute folder', () => {
    const absoluteChild = seedObservation('mem-abs', 'Absolute child', [`${root}/src/utils/a.ts`]);
    const relativeChild = seedObservation('mem-rel', 'Relative child', [], ['src/utils/b.ts']);
    seedObservation('mem-deeper', 'Deeper file', ['src/utils/nested/c.ts']);
    seedObservation('mem-sibling', 'Sibling folder', ['src/other/d.ts']);

    const { observations } = search.findByFile(`${root}/src/utils`, { project, isFolder: true });

    expect(observations.map(obs => obs.id).sort()).toEqual([absoluteChild, relativeChild].sort());
  });

  it('finds a session summary whose files are project-relative', () => {
    session('mem-summary');
    const summaryId = store.importSessionSummary({
      memory_session_id: 'mem-summary',
      project,
      request: 'Refactor utils',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: JSON.stringify(['src/utils/b.ts']),
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    }).id;

    const { sessions } = search.findByFile(`${root}/src/utils`, { project, isFolder: true });

    expect(sessions.map(summary => summary.id)).toEqual([summaryId]);
  });

  it('matches project-relative children of a Windows folder in either separator', () => {
    const forwardSlashes = seedObservation('mem-forward', 'Forward slashes', ['src/utils/a.ts']);
    const backslashes = seedObservation('mem-back', 'Backslashes', ['src\\utils\\b.ts']);

    const { observations } = search.findByFile('C:\\Users\\user\\folder-project\\src\\utils', { project, isFolder: true });

    expect(observations.map(obs => obs.id).sort()).toEqual([forwardSlashes, backslashes].sort());
  });

  for (const folder of ['.', './', '.\\']) {
    for (const surface of ['observations', 'sessions'] as const) {
      it(`finds extensionless root ${surface} for ${JSON.stringify(folder)} without admitting nested files`, () => {
        const expected: number[] = [];
        const summaryIds: number[] = [];
        for (const [index, path] of ['Makefile', 'LICENSE', 'Dockerfile', 'README.md', './NOTICE', '.\\COPYING', 'src/nested.ts', 'src/LICENSE'].entries()) {
          const memoryId = `root-${index}`;
          const modified = index % 2 === 1;
          const observation = seedObservation(memoryId, path, modified ? [] : [path], modified ? [path] : []);
          const epoch = 100 + index;
          store.db.run('UPDATE observations SET created_at_epoch = ? WHERE id = ?', [epoch, observation]);
          const summary = store.importSessionSummary({
            memory_session_id: memoryId, project, request: path, investigated: null,
            learned: null, completed: null, next_steps: null, notes: null,
            files_read: modified ? null : JSON.stringify([path]),
            files_edited: modified ? JSON.stringify([path]) : null,
            prompt_number: 1, discovery_tokens: 0,
            created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
          }).id;
          if (index < 6) { expected.unshift(observation); summaryIds.unshift(summary); }
        }

        const result = search.findByFile(folder, { project, isFolder: true });
        const wanted = surface === 'observations' ? expected : summaryIds;
        expect(result[surface].map(row => row.id)).toEqual(wanted);
        const page = search.findByFile(folder, { project, isFolder: true, limit: 2, offset: 3 });
        expect(page[surface].map(row => row.id)).toEqual(wanted.slice(3, 5));
        expect(search.findByFile(folder, { project, isFolder: true, offset: 6 }))
          .toEqual({ observations: [], sessions: [] });
      });
    }
  }

});

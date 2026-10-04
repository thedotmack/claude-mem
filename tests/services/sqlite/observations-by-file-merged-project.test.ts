import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';

describe('file context for merged projects', () => {
  let store: SessionStore | undefined;
  afterEach(() => { store?.close(); });

  function seed(project: string, mergedInto: string | null, platform: string): number {
    const sessionId = `session-${project}-${platform}`;
    const id = store!.createSDKSession(sessionId, project, 'prompt', undefined, platform);
    store!.ensureMemorySessionIdRegistered(id, sessionId);
    const obs = store!.storeObservation(sessionId, project, {
      type: 'discovery', title: project, subtitle: null, facts: [], narrative: 'file finding',
      concepts: [], files_read: ['src/main.ts'], files_modified: [],
    }, 1).id;
    store!.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run(mergedInto, obs);
    return obs;
  }

  it('includes adopted observations while preserving platform and path scope', () => {
    store = new SessionStore(':memory:');
    const adopted = seed('repo/feature', 'repo', 'claude');
    const native = seed('repo', null, 'claude');
    seed('unrelated', null, 'claude');
    seed('repo/other', 'repo', 'codex');
    const results = getObservationsByFilePath(store.db, 'src/main.ts', {
      projects: ['REPO'], platformSource: 'claude',
    });
    expect(results.map(row => row.id).sort()).toEqual([adopted, native].sort());
    expect(getObservationsByFilePath(store.db, 'src/missing.ts', { projects: ['repo'] })).toEqual([]);
  });

  it('still reads the original worktree key and unscoped file context', () => {
    store = new SessionStore(':memory:');
    const adopted = seed('repo/feature', 'repo', 'claude');
    expect(getObservationsByFilePath(store.db, 'src/main.ts', { projects: ['repo/feature'] }).map(row => row.id)).toEqual([adopted]);
    expect(getObservationsByFilePath(store.db, 'src/main.ts').map(row => row.id)).toEqual([adopted]);
  });
});

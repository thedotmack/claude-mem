import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { runOneTimeDoubledProjectCollapse } from '../../../src/services/infrastructure/ProcessManager.js';

// #3641 — one-time collapse of already-written doubled project names. Existing
// users keep observations filed under `<repo>/<repo>` that recall never matches;
// this pass rewrites them to `<repo>` by string match, independent of whether
// the ephemeral worktree path still exists.
describe('runOneTimeDoubledProjectCollapse', () => {
  let dir: string;
  let dbPath: string;

  function seed(memorySessionId: string, project: string, title: string): void {
    const store = new SessionStore(dbPath);
    const sdkId = store.createSDKSession(memorySessionId, project, 'prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, project, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: 'seeded narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
    store.close();
  }

  function projectsFor(memorySessionId: string): { sessions: string[]; observations: string[] } {
    const db = new Database(dbPath, { readonly: true });
    try {
      const sessions = (db.prepare('SELECT project FROM sdk_sessions WHERE memory_session_id = ?')
        .all(memorySessionId) as Array<{ project: string }>).map(r => r.project);
      const observations = (db.prepare('SELECT project FROM observations WHERE memory_session_id = ?')
        .all(memorySessionId) as Array<{ project: string }>).map(r => r.project);
      return { sessions, observations };
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-collapse-'));
    dbPath = join(dir, 'claude-mem.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('collapses a doubled `<repo>/<repo>` project to `<repo>`', () => {
    seed('doubled-mem', 'q-companies-master/q-companies-master', 'Doubled finding');

    runOneTimeDoubledProjectCollapse(dir);

    const { sessions, observations } = projectsFor('doubled-mem');
    expect(sessions).toEqual(['q-companies-master']);
    expect(observations).toEqual(['q-companies-master']);

    // The backup is a SQLite snapshot (VACUUM INTO), so it must be a valid,
    // queryable DB holding the pre-collapse rows — not an empty/partial copy.
    const backupName = readdirSync(dir).find(f => f.startsWith('claude-mem.db.bak-doubled-collapse-'));
    expect(backupName).toBeDefined();
    const backup = new Database(join(dir, backupName!), { readonly: true });
    try {
      const preCollapse = (backup.prepare('SELECT project FROM observations WHERE memory_session_id = ?')
        .all('doubled-mem') as Array<{ project: string }>).map(r => r.project);
      expect(preCollapse).toEqual(['q-companies-master/q-companies-master']);
    } finally {
      backup.close();
    }
  });

  it('leaves a genuine `<parent>/<worktree>` compound name untouched', () => {
    seed('compound-mem', 'main-repo/feature-x', 'Compound finding');

    runOneTimeDoubledProjectCollapse(dir);

    const { sessions, observations } = projectsFor('compound-mem');
    expect(sessions).toEqual(['main-repo/feature-x']);
    expect(observations).toEqual(['main-repo/feature-x']);
  });

  it('leaves a plain project name untouched', () => {
    seed('plain-mem', 'my-repo', 'Plain finding');

    runOneTimeDoubledProjectCollapse(dir);

    const { sessions, observations } = projectsFor('plain-mem');
    expect(sessions).toEqual(['my-repo']);
    expect(observations).toEqual(['my-repo']);
  });

  it('writes the marker and does not re-run', () => {
    seed('doubled-mem', 'repo/repo', 'Doubled finding');

    runOneTimeDoubledProjectCollapse(dir);
    expect(existsSync(join(dir, '.doubled-project-collapse-applied-v1'))).toBe(true);

    // A second doubled name written after the marker exists must be ignored —
    // the pass is one-time.
    seed('doubled-later', 'later/later', 'Later finding');
    runOneTimeDoubledProjectCollapse(dir);
    expect(projectsFor('doubled-later').observations).toEqual(['later/later']);
  });
});

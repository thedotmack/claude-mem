// #4958: worktrees of a bare repository (`alpha.git/worktrees/<name>`,
// `beta/.bare/worktrees/<name>`) now key under their repository
// (`alpha/main`), not under the worktree folder alone (`main`). Adoption must
// agree on the repository's key, and rows stored under the old folder-only key
// must move to the new key, without pulling in another repository's `main`.
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => ({})
    })
  }
}));

import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function makeBareRepo(bareDir: string): void {
  const seed = `${bareDir}-seed`;
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  writeFileSync(path.join(seed, 'README'), 'init\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  mkdirSync(path.dirname(bareDir), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, bareDir], { stdio: 'ignore' });
  rmSync(seed, { recursive: true, force: true });
}

/** `alpha.git` with worktrees under `alpha-trees/`, and `beta/.bare` with worktrees inside `beta/`. */
function makeLayouts(): { root: string; alphaBare: string; betaBare: string; dataDirectory: string } {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-4958-')));
  const alphaBare = path.join(tempRoot, 'alpha.git');
  const betaBare = path.join(tempRoot, 'beta', '.bare');
  makeBareRepo(alphaBare);
  makeBareRepo(betaBare);
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  return { root: tempRoot, alphaBare, betaBare, dataDirectory };
}

function seedSession(
  store: SessionStore,
  name: string,
  project: string,
  checkout: string
): { memorySessionId: string; observationId: number } {
  const sessionDbId = store.createSDKSession(`content-${name}`, project, 'prompt');
  const memorySessionId = `memory-${name}`;
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  store.setSessionCwd(sessionDbId, checkout, 'path');
  const createdAtEpoch = Date.now();
  const { id } = store.importObservation({
    memory_session_id: memorySessionId,
    project,
    text: `work in ${name}`,
    type: 'discovery',
    title: `work in ${name}`,
    subtitle: null,
    facts: null,
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(createdAtEpoch).toISOString(),
    created_at_epoch: createdAtEpoch,
  });
  return { memorySessionId, observationId: id };
}

function observation(dbPath: string, id: number): { project: string; merged_into_project: string | null } {
  const store = new SessionStore(dbPath);
  const row = store.db.prepare(
    'SELECT project, merged_into_project FROM observations WHERE id = ?'
  ).get(id) as { project: string; merged_into_project: string | null };
  store.close();
  return row;
}

function sessionProject(dbPath: string, memorySessionId: string): string {
  const store = new SessionStore(dbPath);
  const row = store.db.prepare(
    'SELECT project FROM sdk_sessions WHERE memory_session_id = ?'
  ).get(memorySessionId) as { project: string };
  store.close();
  return row.project;
}

describe('bare-repository worktree adoption (#4958)', () => {
  it('moves rows stored under the folder-only key to the worktree key, one repository at a time', async () => {
    const { root, alphaBare, betaBare, dataDirectory } = makeLayouts();
    const alphaMain = path.join(root, 'alpha-trees', 'main');
    const betaMain = path.join(root, 'beta', 'main');
    const unrelatedMain = path.join(root, 'elsewhere', 'main');
    git(alphaBare, 'worktree', 'add', '-q', alphaMain);
    git(betaBare, 'worktree', 'add', '-q', path.join(betaMain));
    mkdirSync(unrelatedMain, { recursive: true });

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const alpha = seedSession(store, 'alpha', 'main', path.join(alphaMain, 'src'));
    const beta = seedSession(store, 'beta', 'main', betaMain);
    const unrelated = seedSession(store, 'unrelated', 'main', unrelatedMain);
    store.close();

    const alphaResult = await adoptMergedWorktrees({ repoPath: alphaMain, dataDirectory });
    expect(alphaResult.parentProject).toBe('alpha');
    expect(alphaResult.rekeyedSessions).toBe(1);
    expect(alphaResult.rekeyedObservations).toBe(1);
    expect(sessionProject(dbPath, alpha.memorySessionId)).toBe('alpha/main');
    expect(observation(dbPath, alpha.observationId).project).toBe('alpha/main');
    // Another repository's `main` worktree and a plain `main` folder keep their rows.
    expect(observation(dbPath, beta.observationId).project).toBe('main');
    expect(observation(dbPath, unrelated.observationId).project).toBe('main');

    const betaResult = await adoptMergedWorktrees({ repoPath: betaMain, dataDirectory });
    expect(betaResult.parentProject).toBe('beta');
    expect(observation(dbPath, beta.observationId).project).toBe('beta/main');
    expect(sessionProject(dbPath, beta.memorySessionId)).toBe('beta/main');
    expect(observation(dbPath, unrelated.observationId).project).toBe('main');

    // The re-key travels to other devices as a remap_project op.
    const verify = new SessionStore(dbPath);
    const remaps = (verify.db.prepare('SELECT body FROM sync_outbox').all() as Array<{ body: string }>)
      .map(op => JSON.parse(op.body))
      .filter(op => op.op === 'remap_project' && op.fields.project);
    verify.close();
    expect(remaps.map(op => [op.where.project, op.fields.project])).toEqual([
      ['main', 'alpha/main'],
      ['main', 'beta/main'],
    ]);
  });

  for (const layout of ['alpha.git', 'beta/.bare'] as const) {
    it(`folds merged and deleted worktrees into the repository key (${layout})`, async () => {
      const { root, alphaBare, betaBare, dataDirectory } = makeLayouts();
      const bare = layout === 'alpha.git' ? alphaBare : betaBare;
      const parent = layout === 'alpha.git' ? 'alpha' : 'beta';
      const treesDir = layout === 'alpha.git' ? path.join(root, 'alpha-trees') : path.join(root, 'beta');
      const live = path.join(treesDir, 'main');
      const merged = path.join(treesDir, 'feature');
      const gone = path.join(treesDir, 'gone');
      git(bare, 'worktree', 'add', '-q', live);
      git(bare, 'worktree', 'add', '-q', '-b', 'feature', merged);
      git(bare, 'worktree', 'add', '-q', '-b', 'gone', gone);

      const dbPath = path.join(dataDirectory, 'claude-mem.db');
      const store = new SessionStore(dbPath);
      const mergedRows = seedSession(store, 'feature', `${parent}/feature`, merged);
      const goneRows = seedSession(store, 'gone', `${parent}/gone`, gone);
      store.close();

      git(bare, 'worktree', 'remove', '--force', gone);
      git(bare, 'worktree', 'prune');

      const result = await adoptMergedWorktrees({ repoPath: live, dataDirectory });
      expect(result.parentProject).toBe(parent);
      expect(result.mergedBranches).toContain('feature');
      expect(result.orphanedWorktrees).toEqual([`${parent}/gone`]);
      expect(observation(dbPath, mergedRows.observationId).merged_into_project).toBe(parent);
      expect(observation(dbPath, goneRows.observationId).merged_into_project).toBe(parent);
    });
  }
});

// #2842 + #2864 interaction: submodules get the same `parent/leaf` composite
// key as worktrees, but they are NOT listed by `git worktree list`. The orphan
// sweep treats any composite key with no live worktree as orphaned, so a live,
// actively-used submodule must not be mistaken for a removed worktree and
// folded into its superproject.
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({ callTool: async () => ({}) })
  }
}));

import {
  adoptMergedWorktrees,
  adoptMergedWorktreesForAllKnownRepos
} from '../../../src/services/infrastructure/WorktreeAdoption.js';
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

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
}

function seedObservation(store: SessionStore, memoryId: string, project: string): number {
  return store.importObservation({
    memory_session_id: memoryId,
    project,
    text: 'submodule work',
    type: 'discovery',
    title: `work in ${project}`,
    subtitle: null,
    facts: null,
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(1_700_000_000_000).toISOString(),
    created_at_epoch: 1_700_000_000_000,
  }).id;
}

function mergedInto(dbPath: string, obsId: number): string | null {
  const verify = new SessionStore(dbPath);
  const row = verify.db.prepare(
    'SELECT merged_into_project FROM observations WHERE id = ?'
  ).get(obsId) as { merged_into_project: string | null };
  verify.close();
  return row.merged_into_project;
}

interface Fixture {
  superproject: string;
  submodule: string;
  dataDirectory: string;
  dbPath: string;
  obsId: number;
}

function buildFixture(): Fixture {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-mem-2842-adopt-')));
  const superproject = path.join(tempRoot, 'react');
  const child = path.join(tempRoot, 'peerless-origin');
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(dataDirectory, { recursive: true });

  initRepo(superproject);
  initRepo(child);
  execFileSync(
    'git',
    ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'peerless'],
    { stdio: 'ignore' }
  );
  git(superproject, 'commit', '-m', 'add submodule');

  const submodule = path.join(superproject, 'peerless');
  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const sessionDbId = store.createSDKSession('content-sub', 'react/peerless', 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-sub');
  store.setSessionCwd(sessionDbId, submodule);
  const obsId = seedObservation(store, 'memory-sub', 'react/peerless');
  store.close();

  return { superproject, submodule, dataDirectory, dbPath, obsId };
}

describe('live submodules are not orphans (#2842 + #2864)', () => {
  it('does not adopt a live submodule when adopting the superproject', async () => {
    const fx = buildFixture();

    const result = await adoptMergedWorktrees({
      repoPath: fx.superproject,
      dataDirectory: fx.dataDirectory
    });

    expect(result.orphanedWorktrees).toEqual([]);
    expect(result.adoptedObservations).toBe(0);
    expect(mergedInto(fx.dbPath, fx.obsId)).toBeNull();
  });

  it('does adopt a submodule whose checkout has been deleted', async () => {
    const fx = buildFixture();
    rmSync(fx.submodule, { recursive: true, force: true });

    const result = await adoptMergedWorktrees({
      repoPath: fx.superproject,
      dataDirectory: fx.dataDirectory
    });

    expect(result.orphanedWorktrees).toEqual(['react/peerless']);
    expect(mergedInto(fx.dbPath, fx.obsId)).toBe('react');
  });

  it('does not adopt a live submodule during the startup sweep', async () => {
    const fx = buildFixture();

    await adoptMergedWorktreesForAllKnownRepos({ dataDirectory: fx.dataDirectory });

    expect(mergedInto(fx.dbPath, fx.obsId)).toBeNull();
  });

  // A submodule's --git-common-dir is `<super>/.git/modules/<name>`, not
  // `<super>/.git`, so repo discovery has to walk back past `/.git/modules/`
  // to reach the superproject root. Without that, a session that only ever ran
  // inside a submodule contributes no discoverable repo and the superproject's
  // own orphans are never swept.
  it('discovers the superproject from a submodule-only session cwd', async () => {
    const fx = buildFixture();

    // An orphaned worktree of the SUPERPROJECT — only reachable if discovery
    // resolves `react` from the submodule cwd recorded above.
    const goneWorktree = path.join(tempRoot!, 'gone-wt');
    git(fx.superproject, 'worktree', 'add', '-b', 'gone', goneWorktree);
    const store = new SessionStore(fx.dbPath);
    const sessionDbId = store.createSDKSession('content-gone', 'react/gone-wt', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-gone');
    const orphanObsId = seedObservation(store, 'memory-gone', 'react/gone-wt');
    store.close();
    git(fx.superproject, 'worktree', 'remove', '--force', goneWorktree);
    git(fx.superproject, 'worktree', 'prune');

    // Only the submodule cwd is on record — no session ever ran in `react`.
    const check = new SessionStore(fx.dbPath);
    const cwds = (check.db.prepare(
      "SELECT DISTINCT cwd FROM sdk_sessions WHERE cwd IS NOT NULL AND cwd != ''"
    ).all() as Array<{ cwd: string }>).map(r => r.cwd);
    check.close();
    expect(cwds).toEqual([fx.submodule]);

    await adoptMergedWorktreesForAllKnownRepos({ dataDirectory: fx.dataDirectory });

    expect(mergedInto(fx.dbPath, orphanObsId)).toBe('react');
    expect(mergedInto(fx.dbPath, fx.obsId)).toBeNull();
  });
});

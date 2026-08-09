// #2864 / #2967: observations captured in a worktree keep the composite
// `parent/leaf` project key. Adoption only ever folded them into the parent
// when the worktree was still listed by `git worktree list` AND its branch was
// merged. Delete the worktree after merging — routine cleanup — and the rows
// were stranded: `merged_into_project` stayed NULL and no read path could reach
// them, because the parent↔worktree association was only recomputable from the
// live directory.
//
// A composite key whose worktree is gone is orphaned by definition, so adoption
// folds it into the parent regardless of merge status. Leaving it unreachable
// forever is strictly worse than adopting work from an abandoned branch.
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
}

function seedObservation(store: SessionStore, memorySessionId: string, project: string): number {
  const result = store.importObservation({
    memory_session_id: memorySessionId,
    project,
    text: 'worktree work',
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
  });
  return result.id;
}

function seedSession(store: SessionStore, contentId: string, project: string, memoryId: string): void {
  const sessionDbId = store.createSDKSession(contentId, project, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
}

function mergedInto(dbPath: string, obsId: number): string | null {
  const verify = new SessionStore(dbPath);
  const row = verify.db.prepare(
    'SELECT merged_into_project FROM observations WHERE id = ?'
  ).get(obsId) as { merged_into_project: string | null };
  verify.close();
  return row.merged_into_project;
}

describe('orphaned worktree adoption (#2864)', () => {
  it('adopts observations whose worktree directory no longer exists', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'gone-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    // A worktree that did real work, then was cleaned up after its branch merged.
    git(mainRepo, 'worktree', 'add', '-b', 'gone', worktree);
    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-gone', 'parent-repo/gone-wt', 'memory-gone');
    const obsId = seedObservation(store, 'memory-gone', 'parent-repo/gone-wt');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', worktree);
    git(mainRepo, 'worktree', 'prune');

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.adoptedObservations).toBe(1);
    expect(mergedInto(dbPath, obsId)).toBe('parent-repo');
  });

  it('reports which orphans it adopted rather than folding them silently', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'reported-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    git(mainRepo, 'worktree', 'add', '-b', 'reported', worktree);
    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-reported', 'parent-repo/reported-wt', 'memory-reported');
    seedObservation(store, 'memory-reported', 'parent-repo/reported-wt');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', worktree);
    git(mainRepo, 'worktree', 'prune');

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.orphanedWorktrees).toEqual(['parent-repo/reported-wt']);
  });

  // The Chroma patch runs after the SQL commits and can fail on its own (the
  // data dir allows a single writer, so a CLI run loses to the live worker).
  // selectObsForPatch matches `merged_into_project IS NULL OR = parent`
  // precisely so a later run can re-patch. Orphan detection has to admit
  // already-adopted keys too, or the retry it promises never happens and the
  // vector metadata stays stale forever.
  it('still collects Chroma targets for an already-adopted orphan', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'retry-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    git(mainRepo, 'worktree', 'add', '-b', 'retry', worktree);
    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-retry', 'parent-repo/retry-wt', 'memory-retry');
    seedObservation(store, 'memory-retry', 'parent-repo/retry-wt');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', worktree);
    git(mainRepo, 'worktree', 'prune');

    const first = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });
    expect(first.adoptedObservations).toBe(1);
    expect(first.chromaUpdates).toBe(1);
    expect(first.orphanedWorktrees).toEqual(['parent-repo/retry-wt']);

    const second = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });
    // SQL is a no-op the second time — no double counting, no spurious revs.
    expect(second.adoptedObservations).toBe(0);
    // ...but the row is still offered to Chroma so a failed patch can recover.
    expect(second.chromaUpdates).toBe(1);
    // Reporting stays a changelog of what this run folded in, not a running
    // tally of everything ever adopted.
    expect(second.orphanedWorktrees).toEqual([]);
  });

  it('adopts an orphan even when its branch was never merged', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'abandoned-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    git(mainRepo, 'worktree', 'add', '-b', 'abandoned', worktree);
    writeFileSync(path.join(worktree, 'unmerged.txt'), 'never merged\n');
    git(worktree, 'add', 'unmerged.txt');
    git(worktree, 'commit', '-m', 'unmerged work');

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-abandoned', 'parent-repo/abandoned-wt', 'memory-abandoned');
    const obsId = seedObservation(store, 'memory-abandoned', 'parent-repo/abandoned-wt');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', worktree);
    git(mainRepo, 'worktree', 'prune');

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.adoptedObservations).toBe(1);
    expect(mergedInto(dbPath, obsId)).toBe('parent-repo');
  });

  it('leaves a live worktree with an unmerged branch alone', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'live-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    git(mainRepo, 'worktree', 'add', '-b', 'in-flight', worktree);
    writeFileSync(path.join(worktree, 'wip.txt'), 'work in progress\n');
    git(worktree, 'add', 'wip.txt');
    git(worktree, 'commit', '-m', 'wip');

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-live', 'parent-repo/live-wt', 'memory-live');
    const obsId = seedObservation(store, 'memory-live', 'parent-repo/live-wt');
    store.close();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.adoptedObservations).toBe(0);
    expect(mergedInto(dbPath, obsId)).toBeNull();
  });

  it('does not treat a same-prefix sibling project as an orphan of the parent', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'my_app');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    // `_` is a LIKE wildcard: an unescaped `my_app/%` pattern also matches
    // `myXapp/...`, which belongs to a different repo entirely.
    seedSession(store, 'content-other', 'myXapp/some-wt', 'memory-other');
    const foreignObsId = seedObservation(store, 'memory-other', 'myXapp/some-wt');
    store.close();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.adoptedObservations).toBe(0);
    expect(mergedInto(dbPath, foreignObsId)).toBeNull();
  });
});

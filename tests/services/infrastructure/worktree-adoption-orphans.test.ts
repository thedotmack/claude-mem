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

function seedSessionWithCheckout(
  store: SessionStore,
  contentId: string,
  project: string,
  memoryId: string,
  checkout: string
): void {
  const sessionDbId = store.createSDKSession(contentId, project, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
  store.setSessionCwd(sessionDbId, checkout);
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  // Nested submodules key on their path under the superproject
  // (`outer/alpha/shared`), so a composite key is not always one level deep.
  it('adopts a deeper composite key whose checkout is gone', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-nested', 'parent-repo/vendor/shared', 'memory-nested');
    const obsId = seedObservation(store, 'memory-nested', 'parent-repo/vendor/shared');
    store.close();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.orphanedWorktrees).toEqual(['parent-repo/vendor/shared']);
    expect(mergedInto(dbPath, obsId)).toBe('parent-repo');
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  it('adopts a deleted worktree whose sessions recorded their checkout', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'recorded-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);
    git(mainRepo, 'worktree', 'add', '-b', 'recorded', worktree);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSessionWithCheckout(store, 'content-recorded', 'parent-repo/recorded-wt', 'memory-recorded', worktree);
    const obsId = seedObservation(store, 'memory-recorded', 'parent-repo/recorded-wt');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', worktree);
    git(mainRepo, 'worktree', 'prune');

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.orphanedWorktrees).toEqual(['parent-repo/recorded-wt']);
    expect(mergedInto(dbPath, obsId)).toBe('parent-repo');
  }, 30_000);

  // #2827 — with CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote, another repository's
  // `org/repo` slug has exactly the shape of a composite key under a repository
  // whose folder is named after the org. Its recorded checkout still exists and
  // resolves to a different project, so the sweep must leave it alone.
  it('leaves another repository\'s git-remote slug alone when a repository here is named after its org', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2827-orphan-'));
    const orgNamedRepo = path.join(tempRoot, 'acme');
    const apiRepo = path.join(tempRoot, 'api');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(orgNamedRepo);
    initRepo(apiRepo);
    git(apiRepo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git');

    const savedNameSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    try {
      const dbPath = path.join(dataDirectory, 'claude-mem.db');
      const store = new SessionStore(dbPath);
      seedSessionWithCheckout(store, 'content-api', 'acme/api', 'memory-api', apiRepo);
      const apiObsId = seedObservation(store, 'memory-api', 'acme/api');
      store.close();

      // `acme` has no origin, so it keeps its folder name even in git-remote mode.
      const result = await adoptMergedWorktrees({ repoPath: orgNamedRepo, dataDirectory });

      expect(result.parentProject).toBe('acme');
      expect(result.orphanedWorktrees).toEqual([]);
      expect(mergedInto(dbPath, apiObsId)).toBeNull();
    } finally {
      if (savedNameSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = savedNameSource;
    }
  }, 30_000);

  // #2827 — worktree composites are folder-based keys. With git-remote naming
  // on, a deleted worktree's rows from before the switch are still folded into
  // the repository's folder-based key (which the repository keeps reading), and
  // the rows the repository writes under its slug are left alone.
  it('folds a deleted worktree\'s folder-based rows into the repository in git-remote mode', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2827-orphan-'));
    const mainRepo = path.join(tempRoot, 'widgets');
    const worktree = path.join(tempRoot, 'widgets-feature');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);
    git(mainRepo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    git(mainRepo, 'worktree', 'add', '-b', 'feature', worktree);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSessionWithCheckout(store, 'content-pre', 'widgets/widgets-feature', 'memory-pre', worktree);
    const preSwitchObsId = seedObservation(store, 'memory-pre', 'widgets/widgets-feature');
    seedSessionWithCheckout(store, 'content-slug', 'acme/widgets', 'memory-slug', mainRepo);
    const slugObsId = seedObservation(store, 'memory-slug', 'acme/widgets');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', worktree);
    git(mainRepo, 'worktree', 'prune');

    const savedNameSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    try {
      const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

      expect(result.parentProject).toBe('widgets');
      expect(result.orphanedWorktrees).toEqual(['widgets/widgets-feature']);
      expect(mergedInto(dbPath, preSwitchObsId)).toBe('widgets');
      expect(mergedInto(dbPath, slugObsId)).toBeNull();
    } finally {
      if (savedNameSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = savedNameSource;
    }
  }, 30_000);

  // #2827 — a repository whose slug sits under its own folder key (`acme/acme`
  // in folder `acme`) keeps writing that key; the sweep must not stamp it.
  it('never adopts the key the repository itself writes under git-remote naming', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2827-orphan-'));
    const mainRepo = path.join(tempRoot, 'acme');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);
    git(mainRepo, 'remote', 'add', 'origin', 'https://github.com/acme/acme.git');

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSessionWithCheckout(store, 'content-own', 'acme/acme', 'memory-own', mainRepo);
    const ownObsId = seedObservation(store, 'memory-own', 'acme/acme');
    store.close();

    const savedNameSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    try {
      const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

      expect(result.orphanedWorktrees).toEqual([]);
      expect(mergedInto(dbPath, ownObsId)).toBeNull();
    } finally {
      if (savedNameSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = savedNameSource;
    }
  }, 30_000);

  // #2827 — rows synced from another device carry no local checkout. That device
  // adopts its own orphans and the remap syncs here; adopting them locally could
  // fold another device's slug-named repository into a same-named folder.
  it('leaves a key holding only rows synced from another device to that device', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2827-orphan-'));
    const mainRepo = path.join(tempRoot, 'acme');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    initRepo(mainRepo);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-replica', 'acme/web', 'memory-replica');
    const replicaObsId = seedObservation(store, 'memory-replica', 'acme/web');
    store.db
      .prepare("UPDATE observations SET origin_device_id = 'other-device', origin_local_id = ? WHERE id = ?")
      .run(String(replicaObsId), replicaObsId);
    // A legacy orphan this device wrote before checkouts were recorded is still adopted.
    seedSession(store, 'content-legacy', 'acme/old-wt', 'memory-legacy');
    const legacyObsId = seedObservation(store, 'memory-legacy', 'acme/old-wt');
    store.close();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.orphanedWorktrees).toEqual(['acme/old-wt']);
    expect(mergedInto(dbPath, replicaObsId)).toBeNull();
    expect(mergedInto(dbPath, legacyObsId)).toBe('acme');
  }, 30_000);

  // #3641 — with the write path collapsing a repo-named worktree onto the repo,
  // a LIVE Codex worktree no longer claims its old doubled key, so the sweep
  // folds the rows it wrote before the collapse into the repo. Its merged
  // branch must not be "adopted" onto the repo key itself: that would stamp the
  // repo's own rows as merged into themselves and re-push every one of them.
  it('folds a live Codex worktree\'s pre-collapse rows into the repo without touching the repo\'s own rows', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'app');
    const codexWorktree = path.join(tempRoot, 'codex', 'worktrees', 'c3d4', 'app');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(path.dirname(codexWorktree), { recursive: true });
    initRepo(mainRepo);
    git(mainRepo, 'worktree', 'add', '-b', 'codex-live', codexWorktree);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSessionWithCheckout(store, 'content-doubled', 'app/app', 'memory-doubled', codexWorktree);
    const doubledObsId = seedObservation(store, 'memory-doubled', 'app/app');
    seedSession(store, 'content-repo', 'app', 'memory-repo');
    const repoObsId = seedObservation(store, 'memory-repo', 'app');
    store.close();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.orphanedWorktrees).toEqual(['app/app']);
    expect(mergedInto(dbPath, doubledObsId)).toBe('app');
    expect(mergedInto(dbPath, repoObsId)).toBeNull();

    const verify = new SessionStore(dbPath);
    const ops = (verify.db.prepare('SELECT body FROM sync_outbox').all() as Array<{ body: string }>)
      .map(op => JSON.parse(op.body))
      .filter(op => op.op === 'remap_project');
    verify.close();
    expect(ops.map(op => op.where.project)).toEqual(['app/app']);
  }, 30_000);

  // #3641 — Codex puts worktrees at ~/.codex/worktrees/<id>/<repo>, so the
  // worktree basename equals the repo name and the composite key doubles to
  // `<repo>/<repo>`. Once that worktree is deleted the sweep must still fold the
  // rows into the repo, non-destructively, and queue the remap for cloud sync.
  it('adopts a deleted Codex worktree keyed <repo>/<repo> and queues the remap for sync', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-orphan-'));
    const mainRepo = path.join(tempRoot, 'app');
    const codexWorktree = path.join(tempRoot, 'codex', 'worktrees', 'a1b2', 'app');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(path.dirname(codexWorktree), { recursive: true });
    initRepo(mainRepo);

    git(mainRepo, 'worktree', 'add', '-b', 'codex-task', codexWorktree);
    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    seedSession(store, 'content-codex', 'app/app', 'memory-codex');
    const obsId = seedObservation(store, 'memory-codex', 'app/app');
    store.close();

    git(mainRepo, 'worktree', 'remove', '--force', codexWorktree);
    git(mainRepo, 'worktree', 'prune');

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.orphanedWorktrees).toEqual(['app/app']);
    expect(result.adoptedObservations).toBe(1);
    expect(mergedInto(dbPath, obsId)).toBe('app');

    const verify = new SessionStore(dbPath);
    const project = verify.db.prepare('SELECT project FROM observations WHERE id = ?').get(obsId) as { project: string };
    const ops = (verify.db.prepare('SELECT body FROM sync_outbox').all() as Array<{ body: string }>)
      .map(op => JSON.parse(op.body));
    verify.close();

    // Non-destructive: the stored key is untouched, only the alias is stamped.
    expect(project.project).toBe('app/app');
    expect(ops).toContainEqual({
      op: 'remap_project',
      where: { project: 'app/app', merged_into_project_is_null: true },
      fields: { merged_into_project: 'app' },
    });
  }, 30_000);
});

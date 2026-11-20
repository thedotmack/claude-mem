// A failed git inventory is not an empty one. The orphan sweep adopts every
// composite key with no live checkout, so when `git worktree list` or the
// submodule listing failed and read as "nothing is live", every live checkout's
// memory was folded into the parent and a remap queued for other devices.
//
// The shim runs in a child process because Bun resolves spawned binaries against
// the process's original environment (see worktree-adoption-event-loop.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const ADOPTION_MODULE = path.join(REPO_ROOT, 'src', 'services', 'infrastructure', 'WorktreeAdoption.js');

let tempRoot: string | undefined;
let repositories: Omit<Fixture, 'dataDirectory' | 'dbPath' | 'observations'>;
let repositoryRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'base');
}

function addSubmodule(repo: string, origin: string, relativePath: string): void {
  execFileSync('git', ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, relativePath], { stdio: 'ignore' });
  git(repo, 'commit', '-q', '-m', `add ${relativePath}`);
}

function seed(store: SessionStore, name: string, project: string, checkout: string): number {
  const session = store.createSDKSession(`content-${name}`, project, 'prompt');
  const memorySessionId = `memory-${name}`;
  store.ensureMemorySessionIdRegistered(session, memorySessionId);
  store.setSessionCwd(session, checkout, 'path');
  return store.importObservation({
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
    created_at: new Date(1_700_000_000_000).toISOString(),
    created_at_epoch: 1_700_000_000_000,
  }).id;
}

interface AdoptionOutcome {
  scannedWorktrees: number;
  orphanedWorktrees: string[];
  adoptedObservations: number;
  errors: Array<{ worktree: string; error: string }>;
}

/** Run adoption in a child whose `git` exits 129 for any arguments matching a shell case pattern. */
function adoptWithFailingGit(root: string, repoPath: string, dataDirectory: string, failingArguments: string | null): AdoptionOutcome {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shimDirectory = path.join(root, 'shim');
  mkdirSync(shimDirectory, { recursive: true });
  const shimPath = path.join(shimDirectory, 'git');
  const failingCase = failingArguments ? `case " $* " in\n  ${failingArguments}) exit 129 ;;\nesac\n` : '';
  writeFileSync(shimPath, `#!/bin/sh\n${failingCase}exec "${realGit}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const childScript = `
const { adoptMergedWorktrees } = await import(${JSON.stringify(ADOPTION_MODULE)});
const result = await adoptMergedWorktrees({ repoPath: ${JSON.stringify(repoPath)}, dataDirectory: ${JSON.stringify(dataDirectory)} });
console.log('RESULT:' + JSON.stringify(result));
`;
  const child = Bun.spawnSync([process.execPath, '-e', childScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}`, CLAUDE_MEM_DATA_DIR: dataDirectory },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  const resultLine = child.stdout.toString().split('\n').find(line => line.startsWith('RESULT:'));
  if (child.exitCode !== 0 || !resultLine) {
    throw new Error(`adoption child failed (${child.exitCode}): ${child.stderr.toString()}`);
  }
  return JSON.parse(resultLine.slice('RESULT:'.length));
}

interface Fixture {
  root: string;
  repo: string;
  worktree: string;
  submodule: string;
  nestedSubmodule: string;
  dataDirectory: string;
  dbPath: string;
  observations: { liveWorktree: number; liveSubmodule: number; liveNested: number; removedWorktree: number };
}

/** `react` with an unmerged live worktree, a live submodule holding a nested one, and one removed worktree's rows. */
function buildRepositories(): Omit<Fixture, 'dataDirectory' | 'dbPath' | 'observations'> {
  repositoryRoot = mkdtempSync(path.join(tmpdir(), 'cm-adoption-inventory-'));
  const root = realpathSync(repositoryRoot);
  const repo = path.join(root, 'react');
  initRepo(repo);
  const worktree = path.join(root, 'topic');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree);
  git(worktree, 'config', 'user.email', 'test@example.com');
  git(worktree, 'config', 'user.name', 'Test');
  writeFileSync(path.join(worktree, 'topic.txt'), 'unmerged work\n');
  git(worktree, 'add', 'topic.txt');
  git(worktree, 'commit', '-q', '-m', 'unmerged topic');

  const nestedOrigin = path.join(root, 'nested-origin');
  const peerOrigin = path.join(root, 'peer-origin');
  initRepo(nestedOrigin);
  initRepo(peerOrigin);
  addSubmodule(repo, peerOrigin, 'peer');
  const submodule = path.join(repo, 'peer');
  git(submodule, 'config', 'user.email', 'test@example.com');
  git(submodule, 'config', 'user.name', 'Test');
  addSubmodule(submodule, nestedOrigin, 'nested');
  const nestedSubmodule = path.join(submodule, 'nested');

  return { root, repo, worktree, submodule, nestedSubmodule };
}

function buildFixture(): Fixture {
  const { root, worktree, submodule, nestedSubmodule } = repositories;
  const dataDirectory = mkdtempSync(path.join(root, 'data-'));
  tempRoot = dataDirectory;
  writeFileSync(path.join(dataDirectory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }));
  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const observations = {
    liveWorktree: seed(store, 'worktree', 'react/topic', worktree),
    liveSubmodule: seed(store, 'submodule', 'react/peer', submodule),
    liveNested: seed(store, 'nested', 'react/peer/nested', nestedSubmodule),
    removedWorktree: seed(store, 'removed', 'react/gone', path.join(root, 'gone')),
  };
  store.close();
  return { ...repositories, dataDirectory, dbPath, observations };
}

function adoptedInto(dbPath: string, observationId: number): string | null {
  const store = new SessionStore(dbPath);
  const row = store.db.prepare('SELECT merged_into_project FROM observations WHERE id = ?').get(observationId) as { merged_into_project: string | null };
  store.close();
  return row.merged_into_project;
}

function queuedRemapBodies(dbPath: string): string[] {
  const store = new SessionStore(dbPath);
  const rows = store.db.prepare("SELECT body FROM sync_outbox WHERE body LIKE '%remap_project%'").all() as Array<{ body: string }>;
  store.close();
  return rows.map(row => row.body);
}

describe.skipIf(process.platform === 'win32')('worktree adoption when a git inventory fails', () => {
  beforeAll(() => {
    repositories = buildRepositories();
  }, 60_000);

  afterAll(() => {
    if (repositoryRoot) rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it('falls back to line output on a Git without `worktree list -z`, and the sweep still runs', () => {
    const fx = buildFixture();
    const result = adoptWithFailingGit(fx.root, fx.repo, fx.dataDirectory, '*" worktree list --porcelain -z "*');

    expect(result.scannedWorktrees).toBe(1);
    expect(result.errors).toEqual([]);
    expect(adoptedInto(fx.dbPath, fx.observations.liveWorktree)).toBeNull();
    expect(adoptedInto(fx.dbPath, fx.observations.liveSubmodule)).toBeNull();
    expect(adoptedInto(fx.dbPath, fx.observations.liveNested)).toBeNull();
    expect(result.orphanedWorktrees).toEqual(['react/gone']);
    expect(adoptedInto(fx.dbPath, fx.observations.removedWorktree)).toBe('react');
  }, 60_000);

  const failedInventories: Array<{ name: string; failingArguments: (fx: Fixture) => string }> = [
    { name: 'both forms of `worktree list`', failingArguments: () => '*" worktree list "*' },
    { name: 'the submodule listing', failingArguments: fx => `*"-C ${fx.repo} ls-files "*` },
    { name: 'a nested submodule listing', failingArguments: fx => `*"-C ${fx.submodule} ls-files "*` },
  ];

  for (const { name, failingArguments } of failedInventories) {
    it(`skips the orphan sweep and reports it when ${name} fails`, () => {
      const fx = buildFixture();
      const result = adoptWithFailingGit(fx.root, fx.repo, fx.dataDirectory, failingArguments(fx));

      expect(result.adoptedObservations).toBe(0);
      expect(result.orphanedWorktrees).toEqual([]);
      for (const observationId of Object.values(fx.observations)) {
        expect(adoptedInto(fx.dbPath, observationId)).toBeNull();
      }
      expect(queuedRemapBodies(fx.dbPath)).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].worktree).toBe(fx.repo);
      expect(result.errors[0].error).toContain('orphan sweep skipped');
    }, 60_000);
  }
});

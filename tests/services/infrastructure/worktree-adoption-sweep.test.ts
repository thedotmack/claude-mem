// #2864 / #2967: the startup adoption sweep discovered parent repos by reading
// distinct `cwd` values out of `pending_messages`. That table stopped being
// written in 61fe70a2 ("remove retry/observation queue, replace with
// SessionMessageBuffer", v13.10.0), so the sweep found zero repos on every
// startup and adoption only ever ran when a user invoked `npx claude-mem adopt`
// by hand. Sessions now persist their cwd on `sdk_sessions`, and the sweep
// reads from there.
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { adoptMergedWorktreesForAllKnownRepos } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function seedObservation(store: SessionStore, memorySessionId: string, project: string): void {
  store.importObservation({
    memory_session_id: memorySessionId,
    project,
    text: 'worktree work',
    type: 'discovery',
    title: 'worktree work',
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
}

describe('adoption sweep repo discovery (#2864)', () => {
  it('discovers parent repos from sdk_sessions.cwd when pending_messages is empty', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-sweep-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    const worktree = path.join(tempRoot, 'feature-wt');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(dataDirectory);

    git(mainRepo, 'init', '-b', 'main');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(mainRepo, 'README.md'), 'base\n');
    git(mainRepo, 'add', 'README.md');
    git(mainRepo, 'commit', '-m', 'base');
    git(mainRepo, 'worktree', 'add', '-b', 'feature', worktree);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const sessionDbId = store.createSDKSession('content-1', 'parent-repo/feature-wt', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-1');
    store.setSessionCwd(sessionDbId, worktree);
    seedObservation(store, 'memory-1', 'parent-repo/feature-wt');

    const pendingCount = (store.db.prepare(
      'SELECT COUNT(*) AS n FROM pending_messages'
    ).get() as { n: number }).n;
    store.close();

    // Guard the premise: the sweep must not be relying on the dead table.
    expect(pendingCount).toBe(0);

    const results = await adoptMergedWorktreesForAllKnownRepos({ dataDirectory, dryRun: true });

    const parent = results.find(r => r.parentProject === 'parent-repo');
    expect(parent).toBeDefined();
    expect(parent!.adoptedObservations).toBe(1);
  });
});

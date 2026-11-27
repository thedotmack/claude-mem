import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const chromaCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let failChromaLookups = false;
const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        chromaCalls.push({ name, args });
        if (name === 'chroma_create_collection') return {};
        if (name === 'chroma_get_documents') {
          if (failChromaLookups) throw new Error('chroma-mcp did not answer in time');
          return {
            ids: ['summary_1_request'],
            metadatas: [{ sqlite_id: 1, doc_type: 'session_summary' }]
          };
        }
        return {};
      }
    })
  }
}));

import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';

function syncStatePath(): string {
  return path.join(process.env.CLAUDE_MEM_DATA_DIR!, 'chroma-sync-state.json');
}

beforeEach(() => {
  // A store that has synced before: the digest is never the file's first entry.
  ChromaSyncState.bump('synced-before', 'observations', 1);
});

let tempRoot: string | undefined;
let mainRepoForCleanup: string | undefined;

afterEach(() => {
  chromaCalls.length = 0;
  failChromaLookups = false;
  ChromaSyncState.resetCacheForTests();
  rmSync(syncStatePath(), { recursive: true, force: true });
  if (mainRepoForCleanup && existsSync(mainRepoForCleanup)) {
    try { git(mainRepoForCleanup, 'worktree', 'remove', '--force', path.join(tempRoot!, 'summary-worktree')); } catch {}
  }
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
  mainRepoForCleanup = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

/** A parent repo with one worktree on branch `feature` that holds one session summary. */
function createRepoWithSummaryWorktree(): { mainRepo: string; dataDirectory: string; dbPath: string; summaryId: number } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-3331-'));
  const mainRepo = path.join(tempRoot, 'parent-repo');
  mainRepoForCleanup = mainRepo;
  const worktree = path.join(tempRoot, 'summary-worktree');
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
  const sdkSessionId = store.createSDKSession('content-summary', 'parent-repo/summary-worktree', 'prompt');
  store.ensureMemorySessionIdRegistered(sdkSessionId, 'summary-session');
  const summary = store.importSessionSummary({
    memory_session_id: 'summary-session',
    project: 'parent-repo/summary-worktree',
    request: 'summary only',
    investigated: null,
    learned: null,
    completed: null,
    next_steps: null,
    files_read: null,
    files_edited: null,
    notes: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(1_700_000_000_000).toISOString(),
    created_at_epoch: 1_700_000_000_000,
  });
  store.close();
  return { mainRepo, dataDirectory, dbPath, summaryId: summary.id };
}

function lookupCalls(): number {
  return chromaCalls.filter(call => call.name === 'chroma_get_documents').length;
}

function patchedIds(): unknown {
  return chromaCalls.find(call => call.name === 'chroma_update_documents')?.args.ids;
}

/** Runs adoption and returns how many Chroma lookups that run made. */
async function adoptAndCountLookups(mainRepo: string, dataDirectory: string): Promise<number> {
  chromaCalls.length = 0;
  await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });
  return lookupCalls();
}

describe('worktree adoption Chroma hydration', () => {
  it('patches a session-summary document when the adopted worktree has no observations', async () => {
    const { mainRepo, dataDirectory, dbPath, summaryId } = createRepoWithSummaryWorktree();

    const result = await adoptMergedWorktrees({
      repoPath: mainRepo,
      dataDirectory,
      onlyBranch: 'feature'
    });

    const verify = new SessionStore(dbPath);
    const mergedProject = (verify.db.prepare(
      'SELECT merged_into_project FROM session_summaries WHERE id = ?'
    ).get(summaryId) as { merged_into_project: string }).merged_into_project;
    verify.close();

    expect(result.adoptedObservations).toBe(0);
    expect(result.adoptedSummaries).toBe(1);
    expect(mergedProject).toBe('parent-repo');
    expect(chromaCalls.find(call => call.name === 'chroma_update_documents')?.args.ids)
      .toEqual(['summary_1_request']);
  }, 30_000);

  it('reads the adopted documents once to adopt, once to verify, then not again', async () => {
    const { mainRepo, dataDirectory } = createRepoWithSummaryWorktree();
    git(mainRepo, 'merge', '--no-ff', '-m', 'merge feature', 'feature');

    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(1);
    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(1);
    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(0);
  }, 30_000);

  it('patches a row whose single-branch patch failed, though its branch is still unmerged', async () => {
    const { mainRepo, dataDirectory } = createRepoWithSummaryWorktree();

    failChromaLookups = true;
    const branchRun = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, onlyBranch: 'feature' });
    expect(branchRun.adoptedSummaries).toBe(1);
    expect(branchRun.chromaFailed).toBe(1);

    // `feature` is a live, unmerged worktree: a plain run does not target it.
    failChromaLookups = false;
    chromaCalls.length = 0;
    const plainRun = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(plainRun.adoptedSummaries).toBe(0);
    expect(patchedIds()).toEqual(['summary_1_request']);
  }, 30_000);

  it('reads rows that another connection adopted after a verified run', async () => {
    const { mainRepo, dataDirectory, dbPath } = createRepoWithSummaryWorktree();
    git(mainRepo, 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    await adoptAndCountLookups(mainRepo, dataDirectory);
    await adoptAndCountLookups(mainRepo, dataDirectory);
    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(0);

    const store = new SessionStore(dbPath);
    const sdkSessionId = store.createSDKSession('content-other', 'parent-repo/other-worktree', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkSessionId, 'other-session');
    const other = store.importSessionSummary({
      memory_session_id: 'other-session',
      project: 'parent-repo/other-worktree',
      request: 'adopted elsewhere',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_001_000).toISOString(),
      created_at_epoch: 1_700_000_001_000,
    });
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE id = ?').run('parent-repo', other.id);
    store.close();

    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(1);
    const lookedUp = chromaCalls.find(call => call.name === 'chroma_get_documents')?.args.where as
      { sqlite_id: { $in: number[] } };
    expect(lookedUp.sqlite_id.$in).toContain(other.id);
  }, 30_000);

  it('patches the adopted row on the run after its lookups failed', async () => {
    const { mainRepo, dataDirectory } = createRepoWithSummaryWorktree();
    git(mainRepo, 'merge', '--no-ff', '-m', 'merge feature', 'feature');

    failChromaLookups = true;
    const failed = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });
    expect(failed.adoptedSummaries).toBe(1);
    expect(failed.chromaFailed).toBe(1);

    failChromaLookups = false;
    chromaCalls.length = 0;
    const retried = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(retried.adoptedSummaries).toBe(0);
    expect(patchedIds()).toEqual(['summary_1_request']);
  }, 30_000);

  it('reads again after a restart when the verified digest could not be written', async () => {
    const { mainRepo, dataDirectory } = createRepoWithSummaryWorktree();
    git(mainRepo, 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    await adoptAndCountLookups(mainRepo, dataDirectory);

    // A directory with a file in it cannot be replaced by the state file.
    rmSync(syncStatePath(), { force: true });
    mkdirSync(path.join(syncStatePath(), 'blocker'), { recursive: true });
    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(1);

    ChromaSyncState.resetCacheForTests();
    expect(await adoptAndCountLookups(mainRepo, dataDirectory)).toBe(1);
  }, 30_000);
});

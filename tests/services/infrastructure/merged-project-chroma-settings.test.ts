import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
const chromaCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let managerRequests = 0;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => {
      managerRequests++;
      return {
        callTool: async (name: string, args: Record<string, unknown>) => {
          chromaCalls.push({ name, args });
          if (name === 'chroma_get_documents') {
            const where = args.where as {
              $and: [{ doc_type: string }, { sqlite_id: { $in: number[] } }];
            };
            const docType = where.$and[0].doc_type;
            const ids = where.$and[1].sqlite_id.$in;
            return {
              ids: ids.map(id => `${docType}_${id}`),
              metadatas: ids.map(id => ({ doc_type: docType, sqlite_id: id }))
            };
          }
          return {};
        }
      };
    }
  }
}));

import {
  adoptMergedWorktrees,
  adoptMergedWorktreesForAllKnownRepos,
  type AdoptionResult
} from '../../../src/services/infrastructure/WorktreeAdoption.js';
import {
  mergeProjectInto,
  type ProjectMergeResult
} from '../../../src/services/infrastructure/ProjectMerge.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const sourceProject = 'parent-repo/feature-worktree';
const targetProject = 'parent-repo';
let tempRoot: string | undefined;
let savedChromaEnabled: string | undefined;

beforeEach(() => {
  savedChromaEnabled = process.env.CLAUDE_MEM_CHROMA_ENABLED;
  delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
  managerRequests = 0;
  chromaCalls.length = 0;
});

afterEach(() => {
  if (savedChromaEnabled === undefined) delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
  else process.env.CLAUDE_MEM_CHROMA_ENABLED = savedChromaEnabled;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

interface Fixture {
  mainRepo: string;
  dataDirectory: string;
  dbPath: string;
}

function fixture(chromaEnabled: 'false' | 'true'): Fixture {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-merged-chroma-'));
  const mainRepo = path.join(tempRoot, targetProject);
  const worktree = path.join(tempRoot, 'feature-worktree');
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(mainRepo);
  mkdirSync(dataDirectory);

  const git = (...args: string[]) => execFileSync('git', ['-C', mainRepo, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(mainRepo, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-m', 'base');
  git('worktree', 'add', '-b', 'feature', worktree);

  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const sessionId = store.createSDKSession('content-feature', sourceProject, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionId, 'memory-feature');
  store.setSessionCwd(sessionId, worktree);
  store.importObservation({
    memory_session_id: 'memory-feature',
    project: sourceProject,
    text: 'work',
    type: 'discovery',
    title: 'work in feature',
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
  store.storeSummary('memory-feature', sourceProject, {
    request: 'request',
    investigated: 'investigated',
    learned: 'learned',
    completed: 'completed',
    next_steps: 'next',
    notes: null,
  }, 1, 0, 1_700_000_000_000);
  store.close();
  writeSettings(dataDirectory, chromaEnabled);
  return { mainRepo, dataDirectory, dbPath };
}

function writeSettings(dataDirectory: string, chromaEnabled: 'false' | 'true'): void {
  writeFileSync(path.join(dataDirectory, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_CHROMA_ENABLED: chromaEnabled
  }));
}

function expectSqliteMerge(dbPath: string): void {
  const store = new SessionStore(dbPath);
  const observation = store.db.prepare('SELECT project, merged_into_project FROM observations').get();
  const summary = store.db.prepare('SELECT project, merged_into_project FROM session_summaries').get();
  const ops = (store.db.prepare('SELECT body FROM sync_outbox').all() as Array<{ body: string }>)
    .map(op => JSON.parse(op.body));
  store.close();

  expect(observation).toEqual({ project: sourceProject, merged_into_project: targetProject });
  expect(summary).toEqual({ project: sourceProject, merged_into_project: targetProject });
  expect(ops).toContainEqual({
    op: 'remap_project',
    where: { project: sourceProject, merged_into_project_is_null: true },
    fields: { merged_into_project: targetProject },
  });
}

function mergedCounts(result: AdoptionResult | ProjectMergeResult): number[] {
  return 'adoptedObservations' in result
    ? [result.adoptedObservations, result.adoptedSummaries]
    : [result.mergedObservations, result.mergedSummaries];
}

function expectChromaPatch(result: AdoptionResult | ProjectMergeResult): void {
  expect(result.chromaUpdates).toBe(2);
  expect(result.chromaFailed).toBe(0);
  const patches = chromaCalls.filter(call => call.name === 'chroma_update_documents');
  expect(patches.map(call => call.args.ids)).toEqual([['observation_1'], ['session_summary_1']]);
  expect(patches.map(call => call.args.metadatas)).toEqual([
    [{ doc_type: 'observation', sqlite_id: 1, merged_into_project: targetProject }],
    [{ doc_type: 'session_summary', sqlite_id: 1, merged_into_project: targetProject }]
  ]);
}

const operations: Array<{
  name: string;
  run: (fixture: Fixture) => Promise<AdoptionResult | ProjectMergeResult>;
}> = [
  {
    name: 'worktree adoption',
    run: ({ mainRepo, dataDirectory }) => adoptMergedWorktrees({
      repoPath: mainRepo, dataDirectory, onlyBranch: 'feature'
    })
  },
  {
    name: 'startup worktree sweep',
    run: async ({ dataDirectory }) => {
      const results = await adoptMergedWorktreesForAllKnownRepos({ dataDirectory });
      const result = results.find(result => result.parentProject === targetProject);
      if (!result) throw new Error('startup sweep did not discover the fixture repository');
      return result;
    }
  },
  {
    name: 'project merge',
    run: ({ dataDirectory }) => mergeProjectInto({
      from: sourceProject, into: targetProject, dataDirectory
    })
  }
];

for (const operation of operations) {
  describe(`${operation.name} Chroma settings`, () => {
    it('merges only SQLite when disabled, then patches existing rows when re-enabled', async () => {
      const data = fixture('false');
      const result = await operation.run(data);

      expect(mergedCounts(result)).toEqual([1, 1]);
      expectSqliteMerge(data.dbPath);
      expect(managerRequests).toBe(0);
      expect(chromaCalls).toEqual([]);
      expect(result.chromaUpdates).toBe(0);
      expect(result.chromaFailed).toBe(0);

      writeSettings(data.dataDirectory, 'true');
      const retry = await operation.run(data);
      expect(mergedCounts(retry)).toEqual([0, 0]);
      expectChromaPatch(retry);
    });

    it('lets the disabling environment variable override enabled file settings', async () => {
      const data = fixture('true');
      process.env.CLAUDE_MEM_CHROMA_ENABLED = 'false';
      const result = await operation.run(data);

      expect(mergedCounts(result)).toEqual([1, 1]);
      expectSqliteMerge(data.dbPath);
      expect(managerRequests).toBe(0);
      expect(chromaCalls).toEqual([]);
      expect(result.chromaUpdates).toBe(0);
      expect(result.chromaFailed).toBe(0);
    });

    it('lets the enabling environment variable override disabled file settings', async () => {
      const data = fixture('false');
      process.env.CLAUDE_MEM_CHROMA_ENABLED = 'true';
      const result = await operation.run(data);

      expect(mergedCounts(result)).toEqual([1, 1]);
      expectSqliteMerge(data.dbPath);
      expectChromaPatch(result);
    });
  });
}

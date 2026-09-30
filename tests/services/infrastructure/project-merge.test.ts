// plan-20 step 2 — `claude-mem project merge <from> <into>` folds one project's
// memory into another without rewriting any row, and the fold travels to every
// device through cloud sync as a remap_project op.
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

import { mergeProjectInto } from '../../../src/services/infrastructure/ProjectMerge.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function seed(store: SessionStore, memoryId: string, project: string): number {
  const sessionDbId = store.createSDKSession(`content-${memoryId}`, project, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
  return store.importObservation({
    memory_session_id: memoryId,
    project,
    text: 'work',
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

function freshDatabase(): { dataDirectory: string; dbPath: string } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-project-merge-'));
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  return { dataDirectory, dbPath: path.join(dataDirectory, 'claude-mem.db') };
}

describe('project merge (plan-20)', () => {
  it('stamps merged_into_project, keeps project, and queues the remap for cloud sync', async () => {
    const { dataDirectory, dbPath } = freshDatabase();
    const store = new SessionStore(dbPath);
    const fromId = seed(store, 'memory-a', 'frontend');
    const otherId = seed(store, 'memory-b', 'unrelated');
    store.close();

    const result = await mergeProjectInto({ from: 'frontend', into: 'work', dataDirectory });
    expect(result.mergedObservations).toBe(1);

    const verify = new SessionStore(dbPath);
    const rows = verify.db.prepare('SELECT id, project, merged_into_project FROM observations ORDER BY id').all() as Array<{
      id: number; project: string; merged_into_project: string | null;
    }>;
    const ops = (verify.db.prepare('SELECT body FROM sync_outbox').all() as Array<{ body: string }>)
      .map(op => JSON.parse(op.body));
    verify.close();

    expect(rows).toEqual([
      { id: fromId, project: 'frontend', merged_into_project: 'work' },
      { id: otherId, project: 'unrelated', merged_into_project: null },
    ]);
    expect(ops).toContainEqual({
      op: 'remap_project',
      where: { project: 'frontend', merged_into_project_is_null: true },
      fields: { merged_into_project: 'work' },
    });
  });

  it('dry run reports the counts and changes nothing', async () => {
    const { dataDirectory, dbPath } = freshDatabase();
    const store = new SessionStore(dbPath);
    seed(store, 'memory-a', 'frontend');
    store.close();

    const result = await mergeProjectInto({ from: 'frontend', into: 'work', dataDirectory, dryRun: true });
    expect(result.mergedObservations).toBe(1);

    const verify = new SessionStore(dbPath);
    const merged = verify.db.prepare('SELECT merged_into_project FROM observations').get() as { merged_into_project: string | null };
    const ops = verify.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE body LIKE '%remap_project%'").get() as { n: number };
    verify.close();
    expect(merged.merged_into_project).toBeNull();
    expect(ops.n).toBe(0);
  });

  it('leaves rows already merged elsewhere alone', async () => {
    const { dataDirectory, dbPath } = freshDatabase();
    const store = new SessionStore(dbPath);
    const adoptedId = seed(store, 'memory-a', 'repo/feature');
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run('repo', adoptedId);
    store.close();

    const result = await mergeProjectInto({ from: 'repo/feature', into: 'work', dataDirectory });
    expect(result.mergedObservations).toBe(0);

    const verify = new SessionStore(dbPath);
    const row = verify.db.prepare('SELECT merged_into_project FROM observations WHERE id = ?').get(adoptedId) as { merged_into_project: string };
    verify.close();
    expect(row.merged_into_project).toBe('repo');
  });

  // The original merge-environment wrapped each statement in its own try/catch,
  // so a failure committed half a merge and still exited 0.
  it('rolls the whole merge back and fails when any statement fails', async () => {
    const { dataDirectory, dbPath } = freshDatabase();
    const store = new SessionStore(dbPath);
    const obsId = seed(store, 'memory-a', 'frontend');
    store.storeSummary('memory-a', 'frontend', {
      request: 'request',
      investigated: 'investigated',
      learned: 'learned',
      completed: 'completed',
      next_steps: 'next',
      notes: null,
    }, 1, 0, 1_700_000_000_000);
    // Observations are stamped first; make the summaries' stamp fail after that.
    store.db.run(
      "CREATE TRIGGER fail_summary_merge BEFORE UPDATE OF merged_into_project ON session_summaries " +
      "BEGIN SELECT RAISE(ABORT, 'summary stamp failed'); END"
    );
    store.close();

    await expect(mergeProjectInto({ from: 'frontend', into: 'work', dataDirectory })).rejects.toThrow('summary stamp failed');

    const verify = new SessionStore(dbPath);
    const row = verify.db.prepare('SELECT merged_into_project FROM observations WHERE id = ?').get(obsId) as { merged_into_project: string | null };
    const ops = verify.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE body LIKE '%remap_project%'").get() as { n: number };
    verify.close();
    expect(row.merged_into_project).toBeNull();
    expect(ops.n).toBe(0);
  });

  it('refuses a merge into itself', async () => {
    const { dataDirectory, dbPath } = freshDatabase();
    new SessionStore(dbPath).close();
    await expect(mergeProjectInto({ from: 'work', into: 'work', dataDirectory })).rejects.toThrow('both "work"');
  });
});

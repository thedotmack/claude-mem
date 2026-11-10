/**
 * #5664 — a post-delete Chroma cleanup that fails only logged and was dropped.
 * The SQLite row is already committed gone, so the DELETE route answers 404
 * from then on and backfill only walks rows that still exist: the row's
 * documents stayed in Chroma for good.
 *
 * These tests pin the fix at the boundaries that matter:
 *
 * 1. the failure is recorded durably, in the sync checkpoint the write side
 *    already uses for its own pending rows (survives a restart);
 * 2. the next backfill sweep drains the record through the real
 *    `deleteRowDocuments`, then forgets it, so nothing is retried twice;
 * 3. a successful cleanup writes no record at all;
 * 4. a row that exists again (a restore or re-import reused its id) keeps its
 *    documents — the stale delete is dropped instead of orphaning live rows;
 * 5. a connection that comes back in the same worker process drains the record
 *    without waiting for a restart or a sweep (#5664 acceptance text).
 *
 * The records are seeded by writing `chroma-sync-state.json` itself, so these
 * tests fail on the commit before the fix instead of only failing to compile.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';
import type { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

interface IndexedDocument {
  id: string;
  doc_type: string;
  sqlite_id: number;
}

// The stand-in collection: what Chroma still holds for these rows.
let liveDocuments: IndexedDocument[] = [];
// Every chroma_delete_documents batch, in call order.
let deleteCalls: string[][] = [];
// Delete attempts, including the ones an outage rejected.
let deleteAttempts = 0;
// A chroma-mcp outage: mutations fail the way "connection in backoff" did.
let failDeletes = false;
// The listener ChromaSync registers for the manager's recovery edge.
let recoveryListener: (() => void) | null = null;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      acceptsMutations: () => true,
      // The manager reports a successful reconnect here; the real one does the
      // same after a failed connection (see ChromaMcpManager.ensureConnected).
      onConnectionRecovered: (listener: () => void) => {
        recoveryListener = listener;
        return () => {
          if (recoveryListener === listener) recoveryListener = null;
        };
      },
      callTool: async (tool: string, args: any) => {
        if (tool === 'chroma_get_documents') {
          const sqliteId = Number(args?.where?.sqlite_id);
          const matches = liveDocuments.filter(doc => doc.sqlite_id === sqliteId);
          return {
            ids: matches.map(doc => doc.id),
            metadatas: matches.map(doc => ({ sqlite_id: doc.sqlite_id, doc_type: doc.doc_type })),
          };
        }
        if (tool === 'chroma_delete_documents') {
          deleteAttempts += 1;
          if (failDeletes) throw new Error('chroma-mcp connection in backoff (10s remaining)');
          const ids = (args?.ids ?? []) as string[];
          deleteCalls.push(ids);
          liveDocuments = liveDocuments.filter(doc => !ids.includes(doc.id));
          return {};
        }
        // chroma_create_collection and anything else the collection check needs.
        return {};
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { scheduleChromaRowCleanup } from '../../../src/services/sync/chroma-row-cleanup.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

const PENDING_DELETES_KEY = '__pending_row_deletes__';

let dataDir: string;
let previousDataDir: string | undefined;

function statePath(): string {
  return join(dataDir, 'chroma-sync-state.json');
}

function seedStateFile(body: Record<string, unknown>): void {
  writeFileSync(statePath(), JSON.stringify(body));
  ChromaSyncState.resetCacheForTests();
}

function readStateFile(): Record<string, any> {
  return JSON.parse(readFileSync(statePath(), 'utf8'));
}

/**
 * The two queries the sweep makes with no projects to backfill: the project
 * union, and the per-doc-type "does this row exist again" guard.
 */
function makeStore(options: { existingRows?: Array<{ table: string; id: number }> } = {}): SessionStore {
  const existingRows = options.existingRows ?? [];
  return {
    db: {
      prepare(query: string) {
        if (query.includes('SELECT DISTINCT project FROM')) {
          return { all: () => [] };
        }
        if (query.includes('SELECT 1 AS found FROM')) {
          const table = /FROM (\w+)/.exec(query)?.[1] ?? '';
          return {
            get: (id: number) =>
              existingRows.some(row => row.table === table && row.id === id) ? { found: 1 } : undefined,
          };
        }
        throw new Error(`unexpected query in the sweep stub: ${query}`);
      },
    },
  } as unknown as SessionStore;
}

const sweep = () => ChromaSync.backfillAllProjects(makeStore());
const sweepWith = (store: SessionStore) => ChromaSync.backfillAllProjects(store);

/**
 * The manager's recovery edge: it calls the listener ChromaSync registered at
 * worker startup. The retry it starts is async, so tests poll for its effect.
 */
function recoverConnection(): void {
  if (!recoveryListener) {
    throw new Error('ChromaSync never subscribed to the chroma-mcp recovery edge');
  }
  recoveryListener();
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the recovery drain');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-row-cleanup-retry-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  ChromaSyncState.resetCacheForTests();
  liveDocuments = [];
  deleteCalls = [];
  deleteAttempts = 0;
  failDeletes = false;
  recoveryListener = null;
});

afterEach(() => {
  ChromaSyncState.resetCacheForTests();
  if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('post-delete Chroma cleanup retry (#5664)', () => {
  it('drains a recorded cleanup on the next backfill sweep, then does not repeat it', async () => {
    liveDocuments = [{ id: 'obs_7_narrative', doc_type: 'observation', sqlite_id: 7 }];
    seedStateFile({ [PENDING_DELETES_KEY]: [{ docType: 'observation', sqliteId: 7 }] });

    await sweep();

    expect(deleteCalls).toEqual([['obs_7_narrative']]);
    expect(liveDocuments).toEqual([]);
    expect(readStateFile()[PENDING_DELETES_KEY]).toBeUndefined();
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);

    // The record is gone, so a second sweep has nothing to retry.
    await sweep();
    expect(deleteCalls).toEqual([['obs_7_narrative']]);
  });

  it('records a failed cleanup durably and keeps it until a retry lands', async () => {
    liveDocuments = [{ id: 'summary_4_request', doc_type: 'session_summary', sqlite_id: 4 }];
    failDeletes = true;

    // The production cleanup path: the real deleteRowDocuments, a real burst.
    await scheduleChromaRowCleanup(new ChromaSync('claude-mem'), [{ kind: 'summary', id: '4' }]);

    // A restart (fresh cache) still sees it: the record reached the file.
    ChromaSyncState.resetCacheForTests();
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))[PENDING_DELETES_KEY])
      .toEqual([{ docType: 'session_summary', sqliteId: 4 }]);

    // The retry itself fails while the outage lasts: the record stays.
    await sweep();
    expect(deleteCalls).toEqual([]);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([{ docType: 'session_summary', sqliteId: 4 }]);

    failDeletes = false;
    await sweep();
    expect(deleteCalls).toEqual([['summary_4_request']]);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
  });

  it('records nothing when the cleanup succeeds, and never retries it', async () => {
    liveDocuments = [{ id: 'prompt_3', doc_type: 'user_prompt', sqlite_id: 3 }];

    await scheduleChromaRowCleanup(new ChromaSync('claude-mem'), [{ kind: 'prompt', id: 3 }]);

    expect(deleteCalls).toEqual([['prompt_3']]);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
    // A successful cleanup does not touch the checkpoint at all.
    expect(existsSync(statePath())).toBe(false);

    await sweep();
    expect(deleteCalls).toEqual([['prompt_3']]);
  });

  it('drops a stale delete when the row exists again, keeping its documents', async () => {
    liveDocuments = [{ id: 'obs_9_narrative', doc_type: 'observation', sqlite_id: 9 }];
    seedStateFile({ [PENDING_DELETES_KEY]: [{ docType: 'observation', sqliteId: 9 }] });

    // The row came back with the same sqlite id (restore / re-import), so its
    // own sync owns these documents now.
    await sweepWith(makeStore({ existingRows: [{ table: 'observations', id: 9 }] }));

    expect(deleteCalls).toEqual([]);
    expect(liveDocuments.map(doc => doc.id)).toEqual(['obs_9_narrative']);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
  });

  it('records each failed row once, distinguishing doc types that share an id', async () => {
    liveDocuments = [
      { id: 'obs_11_narrative', doc_type: 'observation', sqlite_id: 11 },
      { id: 'summary_11_request', doc_type: 'session_summary', sqlite_id: 11 },
    ];
    failDeletes = true;

    await scheduleChromaRowCleanup(new ChromaSync('claude-mem'), [
      { kind: 'observation', id: '11' },
      { kind: 'observation', id: 11 },
      { kind: 'summary', id: '11' },
    ]);

    // observation 11 and session_summary 11 are different document sets.
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([
      { docType: 'observation', sqliteId: 11 },
      { docType: 'session_summary', sqliteId: 11 },
    ]);
  });

  it('drains a recorded cleanup when chroma-mcp comes back, without a restart or a sweep', async () => {
    liveDocuments = [{ id: 'obs_21_narrative', doc_type: 'observation', sqlite_id: 21 }];
    failDeletes = true;

    // The outage: the live cleanup fails and its record reaches the checkpoint.
    await scheduleChromaRowCleanup(new ChromaSync('claude-mem'), [{ kind: 'observation', id: '21' }]);
    expect(deleteAttempts).toBe(1);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([{ docType: 'observation', sqliteId: 21 }]);
    expect(deleteCalls).toEqual([]);

    // The worker registered its store at startup; that registration is also
    // what subscribes the drain to the manager's recovery edge.
    ChromaSync.registerBackfillStore(makeStore());

    // Same process, no restart and no backfill sweep: the connection recovers.
    failDeletes = false;
    recoverConnection();

    await eventually(() => ChromaSyncState.getPendingRowDeletes().length === 0);

    expect(deleteCalls).toEqual([['obs_21_narrative']]);
    expect(liveDocuments).toEqual([]);
    expect(readStateFile()[PENDING_DELETES_KEY]).toBeUndefined();

    // A further recovery has nothing left to retry.
    const attemptsAfterDrain = deleteAttempts;
    recoverConnection();
    await Bun.sleep(20);
    expect(deleteAttempts).toBe(attemptsAfterDrain);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
  });

  it('keeps a recorded cleanup when the recovery drain itself fails', async () => {
    liveDocuments = [{ id: 'summary_4_request', doc_type: 'session_summary', sqlite_id: 4 }];
    failDeletes = true;

    await scheduleChromaRowCleanup(new ChromaSync('claude-mem'), [{ kind: 'summary', id: '4' }]);
    ChromaSync.registerBackfillStore(makeStore());

    // The manager reports a recovery, but chroma-mcp rejects the deletes again:
    // the record must survive, not be cleared optimistically.
    recoverConnection();
    await eventually(() => deleteAttempts >= 2);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([{ docType: 'session_summary', sqliteId: 4 }]);

    // The next recovery drains it for real.
    failDeletes = false;
    recoverConnection();
    await eventually(() => ChromaSyncState.getPendingRowDeletes().length === 0);
    expect(deleteCalls).toEqual([['summary_4_request']]);
  });
});

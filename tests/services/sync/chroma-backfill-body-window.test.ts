import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

const kinds = ['observations', 'summaries', 'prompts'] as const;
const bodyPrefix = 'bulk-body-fixture:';
const body = bodyPrefix + 'x'.repeat(64 * 1024);
const rowCount = 32;
const project = 'body-window';

describe('Chroma backfill materializes one current body at a time', () => {
  let store: SessionStore;
  let dir: string;
  let priorDataDir: string | undefined;
  let managerSpy: ReturnType<typeof spyOn>;
  let prepareSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;
  let accepting = true;

  beforeEach(() => {
    priorDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), 'chroma-body-window-'));
    process.env.CLAUDE_MEM_DATA_DIR = dir;
    ChromaSyncState.resetCacheForTests();
    store = new SessionStore(':memory:');
    accepting = true;
    managerSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({
      acceptsMutations: () => accepting,
      callTool: async () => ({}),
    } as unknown as ChromaMcpManager);
  });
  afterEach(() => {
    writeSpy?.mockRestore();
    prepareSpy?.mockRestore();
    managerSpy.mockRestore();
    store.close();
    ChromaSyncState.resetCacheForTests();
    if (priorDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = priorDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(kind: typeof kinds[number], pending: boolean) {
    const session = store.createSDKSession('conversation', project, 'request');
    store.ensureMemorySessionIdRegistered(session, 'memory');
    const statement = kind === 'observations'
      ? store.db.prepare(`INSERT INTO observations
          (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
          VALUES ('memory', ?, 'discovery', ?, ?, '2026-11-01T00:00:00.000Z', ?)`)
      : kind === 'summaries'
        ? store.db.prepare(`INSERT INTO session_summaries
            (memory_session_id, project, request, created_at, created_at_epoch)
            VALUES ('memory', ?, ?, '2026-11-01T00:00:00.000Z', ?)`)
        : store.db.prepare(`INSERT INTO user_prompts
            (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
            VALUES (?, 'conversation', ?, ?, '2026-11-01T00:00:00.000Z', ?)`);
    store.db.transaction(() => {
      for (let i = 1; i <= rowCount; i++) {
        if (kind === 'observations') statement.run(project, `Observation ${i}`, body, i);
        else if (kind === 'summaries') statement.run(project, body, i);
        else statement.run(session, i, body, i);
      }
    })();
    statement.finalize();
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0,
      titleOnlyRequeued: true, [kind]: pending ? rowCount : 0,
      pending: pending ? { [kind]: Array.from({ length: rowCount }, (_, i) => i + 1) } : {},
    });
  }

  function trackBodyReads() {
    let bodiesRead = 0;
    const record = (rows: unknown[]) => {
      for (const row of rows) if (row && typeof row === 'object') {
        for (const value of Object.values(row)) {
          if (typeof value === 'string' && value.startsWith(bodyPrefix)) bodiesRead++;
        }
      }
    };
    const prepare = store.db.prepare.bind(store.db);
    prepareSpy = spyOn(store.db, 'prepare').mockImplementation(((...args: Parameters<typeof prepare>) => {
      const statement = prepare(...args);
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      statement.all = (...params: any[]) => { const rows = all(...params); record(rows); return rows; };
      statement.get = (...params: any[]) => { const row = get(...params); record([row]); return row; };
      return statement;
    }) as typeof prepare);
    return () => bodiesRead;
  }

  for (const kind of kinds) for (const pending of [false, true]) {
    it(`defers ${pending ? 'pending' : 'new'} ${kind} bodies until each row's writer turn`, async () => {
      seed(kind, pending);
      const bodiesRead = trackBodyReads();
      const sync = new ChromaSync(project);
      let bodiesAtFirstWrite: number | undefined;
      const writtenIds = new Set<number>();
      writeSpy = spyOn(sync, 'addDocuments').mockImplementation(async documents => {
        bodiesAtFirstWrite ??= bodiesRead();
        for (const document of documents) writtenIds.add(document.metadata.sqlite_id as number);
        return documents.length;
      });
      expect(await sync.ensureBackfilled(project, store)).toBe('completed');
      expect(writtenIds.size).toBe(rowCount);
      expect(bodiesAtFirstWrite).toBe(1);
      expect(bodiesRead()).toBe(rowCount);
      expect(ChromaSyncState.get(project)[kind]).toBe(rowCount);
      expect(ChromaSyncState.getPending(project, kind)).toEqual([]);
    });
  }

  for (const kind of kinds) {
    it(`does not write a pending ${kind} row deleted while an earlier write is in flight`, async () => {
      seed(kind, true);
      const sync = new ChromaSync(project);
      const writtenIds = new Set<number>();
      const table = kind === 'summaries' ? 'session_summaries' : kind === 'prompts' ? 'user_prompts' : kind;
      let deleted = false;
      writeSpy = spyOn(sync, 'addDocuments').mockImplementation(async documents => {
        if (!deleted) {
          deleted = true;
          store.db.prepare(`DELETE FROM ${table} WHERE id = 2`).run();
        }
        for (const document of documents) writtenIds.add(document.metadata.sqlite_id as number);
        return documents.length;
      });
      expect(await sync.ensureBackfilled(project, store)).toBe('completed');
      expect(writtenIds.size).toBe(rowCount - 1);
      expect(writtenIds.has(2)).toBe(false);
      expect(ChromaSyncState.getPending(project, kind)).toEqual([]);
    });
  }

  it('stops fetching bodies when shutdown interrupts the first row', async () => {
    seed('observations', false);
    const bodiesRead = trackBodyReads();
    const sync = new ChromaSync(project);
    writeSpy = spyOn(sync, 'addDocuments').mockImplementation(async documents => {
      accepting = false;
      return documents.length;
    });
    expect(await sync.ensureBackfilled(project, store)).toBe('shutdown');
    expect(bodiesRead()).toBeLessThanOrEqual(2);
    expect(ChromaSyncState.get(project).observations).toBe(1);
  });
});

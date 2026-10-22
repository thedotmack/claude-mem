import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { ObservationSearchResult } from '../../src/services/sqlite/types.js';

const READ_KEYS_STUB = { getProjectReadKeys: (projects: string[]) => projects } as any;

function lastStdoutJson(result: Bun.SyncSubprocess): any {
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
}

function spawnFixture(directory: string, mode: 'worker' | 'inline'): { child: ReturnType<typeof spawn>; portPromise: Promise<number>; searchStarted: Promise<void> } {
  const child = spawn(process.execPath, ['-e', SEARCH_FIXTURE_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SEARCH_FIXTURE_MODE: mode,
      CLAUDE_MEM_DATA_DIR: directory,
      CLAUDE_CONFIG_DIR: directory,
      CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const searchStarted = new Promise<void>(resolve => {
    let stdout = '';
    child.stdout!.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes('SEARCH_STARTED')) resolve();
    });
  });
  const portPromise = new Promise<number>((resolve, reject) => {
    let stdout = '';
    const startupTimer = setTimeout(() => reject(new Error(`search fixture did not start: ${stderr}`)), 15_000);
    child.stdout!.on('data', chunk => {
      stdout += chunk.toString();
      const match = /SEARCH_HTTP_PORT=(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(startupTimer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', code => {
      clearTimeout(startupTimer);
      reject(new Error(`search fixture exited ${code}: ${stderr}`));
    });
  });
  return { child, portPromise, searchStarted };
}

async function stopFixture(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Listen before signalling: a child that exits at once must not leave this waiting forever.
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

const SEARCH_FIXTURE_SCRIPT = `
import { SearchManager } from './src/services/worker/SearchManager.ts';
import { FormattingService } from './src/services/worker/FormattingService.ts';
import { TimelineService } from './src/services/worker/TimelineService.ts';
import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';

const slowSyncRead = () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500);
  return [];
};
const slowInlineSearch = {
  searchObservations: slowSyncRead,
  searchSessions: slowSyncRead,
  searchUserPrompts: slowSyncRead,
};

// Worker mode reads the database the test seeded and holds locked; it opens no writer of its own.
const readKeysStub = { getProjectReadKeys: (projects) => projects };
const searchManager = process.env.SEARCH_FIXTURE_MODE === 'worker'
  ? new SearchManager(slowInlineSearch, readKeysStub, null, new FormattingService(), new TimelineService(), undefined, new ContextReadWorkerClient())
  : new SearchManager(slowInlineSearch, readKeysStub, null, new FormattingService(), new TimelineService());

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path !== '/search') return new Response('Not found', { status: 404 });
    console.log('SEARCH_STARTED');
    const result = await searchManager.search({ query: 'hippoquarx', format: 'json' });
    return Response.json(result);
  },
});
console.log('SEARCH_HTTP_PORT=' + server.port);
`;

describe('SearchManager keyword-read delegation', () => {
  const sentinel = { id: 7, title: 'sentinel observation', created_at_epoch: 1 } as ObservationSearchResult;

  function managerWith(reader: any, sessionSearch: any): SearchManager {
    return new SearchManager(sessionSearch, READ_KEYS_STUB, null, {} as any, {} as any, undefined, reader);
  }

  it('delegates PATH 3 keyword reads to the context reader', async () => {
    const readerSearch = mock(async () => [sentinel]);
    const inlineSearch = mock(() => []);
    const manager = managerWith(
      { searchObservations: readerSearch, searchSessions: mock(async () => []), searchUserPrompts: mock(async () => []) },
      { searchObservations: inlineSearch, searchSessions: mock(() => []), searchUserPrompts: mock(() => []) },
    );

    const result = await manager.search({ query: 'zen garden', format: 'json' });

    expect(readerSearch).toHaveBeenCalledTimes(1);
    expect(readerSearch).toHaveBeenCalledWith('zen garden', { type: undefined, concepts: undefined, files: undefined });
    expect(inlineSearch).not.toHaveBeenCalled();
    expect(result.observations).toEqual([sentinel]);
  });

  it('answers PATH 3 keyword reads inline when no reader is configured', async () => {
    const inlineSearch = mock(() => [sentinel]);
    const manager = managerWith(
      null,
      { searchObservations: inlineSearch, searchSessions: mock(() => []), searchUserPrompts: mock(() => []) },
    );

    const result = await manager.search({ query: 'zen garden', format: 'json' });

    expect(inlineSearch).toHaveBeenCalledTimes(1);
    expect(result.observations).toEqual([sentinel]);
  });

  it('resolves with empty results when the read worker rejects, matching the inline failure catch', async () => {
    const rejectingReader = {
      searchObservations: async () => { throw new Error('Context reader queue is full'); },
      searchSessions: async () => [],
      searchUserPrompts: async () => [],
    };
    const throwingInline = {
      searchObservations: () => { throw new Error('disk I/O error'); },
      searchSessions: () => [],
      searchUserPrompts: () => [],
    };

    const viaWorker = await managerWith(rejectingReader, { searchObservations: mock(() => []), searchSessions: mock(() => []), searchUserPrompts: mock(() => []) })
      .search({ query: 'zen garden', format: 'json' });
    const viaInline = await managerWith(null, throwingInline).search({ query: 'zen garden', format: 'json' });

    expect(viaWorker.totalResults).toBe(0);
    expect(viaWorker.observations).toEqual([]);
    expect(viaInline.totalResults).toBe(0);
  });

  it('propagates read-worker rejections from the date-ordered merge like inline throws', async () => {
    const observation = {
      id: 5, memory_session_id: 'mem', project: 'searchproj', text: null, type: 'discovery',
      title: 'chroma hit', subtitle: null, facts: '[]', narrative: 'n', concepts: '[]',
      files_read: '[]', files_modified: '[]', prompt_number: 1, discovery_tokens: 0,
      created_at: new Date().toISOString(), created_at_epoch: Date.now(),
    };
    const chromaSync = {
      queryChroma: mock(() => Promise.resolve({
        ids: [observation.id], distances: [0.1],
        metadatas: [{ sqlite_id: observation.id, doc_type: 'observation', project: 'searchproj', created_at_epoch: observation.created_at_epoch }],
      })),
    };
    const sessionStore = {
      getProjectReadKeys: (projects: string[]) => projects,
      getObservationsByIds: mock(() => [observation]),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    };
    const rejectingReader = {
      searchObservations: async () => { throw new Error('Context reader queue is full'); },
      searchSessions: async () => [],
      searchUserPrompts: async () => [],
    };
    const manager = new SearchManager(
      { searchObservations: mock(() => []), searchSessions: mock(() => []), searchUserPrompts: mock(() => []) } as any,
      sessionStore as any,
      chromaSync as any,
      {} as any, {} as any, undefined, rejectingReader,
    );

    await expect(manager.search({ query: 'chroma hit', type: 'observations', orderBy: 'date_desc', format: 'json' }))
      .rejects.toThrow('Context reader queue is full');
  });
});

describe('search reads through the context read worker', () => {
  it('returns byte-identical FTS results through the worker readonly connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-read-worker-'));
    try {
      const seeded = seedSearchDatabase(directory);
      const workerResults = lastStdoutJson(Bun.spawnSync([process.execPath, '-e', `
        import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
        const reader = new ContextReadWorkerClient();
        try {
          console.log(JSON.stringify({
            observations: await reader.searchObservations('quarx', { limit: 10 }),
            sessions: await reader.searchSessions('zebras', { limit: 10 }),
            prompts: await reader.searchUserPrompts('uniquezebra', { limit: 10 }),
            longPrompt: await reader.searchObservations(${JSON.stringify(LONG_PROMPT)}, { limit: 10 }),
            rareTerm: await reader.searchObservations(${JSON.stringify(RARE_TERM_QUERY)}, { limit: 10 }),
          }));
        } finally { await reader.close(); }
      `], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_MEM_TELEMETRY_ENABLED: 'false' },
      }));

      const inlineObservations = seeded.search.searchObservations('quarx', { limit: 10 });
      const inlineSessions = seeded.search.searchSessions('zebras', { limit: 10 });
      const inlinePrompts = seeded.search.searchUserPrompts('uniquezebra', { limit: 10 });
      const inlineLongPrompt = seeded.search.searchObservations(LONG_PROMPT, { limit: 10 });
      const inlineRareTerm = seeded.search.searchObservations(RARE_TERM_QUERY, { limit: 10 });

      expect(workerResults.observations).toEqual(JSON.parse(JSON.stringify(inlineObservations)));
      expect(workerResults.sessions).toEqual(JSON.parse(JSON.stringify(inlineSessions)));
      expect(workerResults.prompts).toEqual(JSON.parse(JSON.stringify(inlinePrompts)));
      expect(workerResults.observations.map((row: { id: number }) => row.id)).toEqual([seeded.shortRowId, seeded.longRowId]);
      expect(workerResults.sessions.length).toBeGreaterThan(0);
      expect(workerResults.prompts.length).toBeGreaterThan(0);
      expect(inlineObservations.map(row => row.id)).toEqual([seeded.shortRowId, seeded.longRowId]);

      // Both need the fts5vocab term frequencies (#4804). Without them the reader falls back to
      // the first 40 tokens: the long prompt's only matching word is past them, and the common
      // word the short query should drop matches every widget row.
      expect(inlineLongPrompt.map(row => row.id)).toEqual([seeded.rareRowId]);
      expect(inlineRareTerm.map(row => row.id)).toEqual([seeded.rareRowId]);
      expect(workerResults.longPrompt).toEqual(JSON.parse(JSON.stringify(inlineLongPrompt)));
      expect(workerResults.rareTerm).toEqual(JSON.parse(JSON.stringify(inlineRareTerm)));

      seeded.search.close();
      seeded.store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps /health responsive while a keyword search read is blocked on the read worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-read-http-'));
    const databasePath = join(directory, 'claude-mem.db');
    // Seed in a separate process so no connection of this one is left open when the journal mode changes.
    const seeded = Bun.spawnSync([process.execPath, '-e', `
      import { SessionStore } from './src/services/sqlite/SessionStore.ts';
      import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
      const store = new SessionStore(${JSON.stringify(databasePath)});
      const session = store.createSDKSession('fixture-a', 'fixtureproj', 'fixture opening prompt');
      store.ensureMemorySessionIdRegistered(session, 'fixture-mem-a');
      store.storeObservation('fixture-mem-a', 'fixtureproj', {
        type: 'discovery', title: 'hippoquarx sighting', subtitle: null,
        facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
      }, 1);
      new SessionSearch(${JSON.stringify(databasePath)}).close();
      store.close();
    `], { cwd: process.cwd(), env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_MEM_TELEMETRY_ENABLED: 'false' } });
    if (seeded.exitCode !== 0) throw new Error(new TextDecoder().decode(seeded.stderr));
    // A rollback-journal exclusive lock blocks readers (WAL would let them through), so the
    // worker's read waits on SQLite's busy timeout until the test releases it.
    const lock = new Database(databasePath);
    lock.exec('PRAGMA journal_mode=DELETE');
    const { child, portPromise, searchStarted } = spawnFixture(directory, 'worker');
    let locked = false;
    try {
      const port = await portPromise;
      lock.exec('BEGIN EXCLUSIVE');
      locked = true;
      let searchSettled = false;
      const searchResponse = fetch(`http://127.0.0.1:${port}/search`, { signal: AbortSignal.timeout(15_000) })
        .finally(() => { searchSettled = true; });
      await searchStarted;
      await delay(100);

      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
      expect(health.ok).toBe(true);
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(searchSettled).toBe(false);

      lock.exec('ROLLBACK');
      locked = false;
      const search = await searchResponse;
      expect(search.ok).toBe(true);
      const result = await search.json();
      expect(result.totalResults).toBeGreaterThan(0);
      expect(result.observations[0].title).toContain('hippoquarx');
    } finally {
      if (locked) lock.exec('ROLLBACK');
      lock.close();
      await stopFixture(child);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('stalls /health when the same search read runs inline on the request thread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-read-http-'));
    const { child, portPromise } = spawnFixture(directory, 'inline');
    try {
      const port = await portPromise;
      const searchResponse = fetch(`http://127.0.0.1:${port}/search`, { signal: AbortSignal.timeout(15_000) });
      await delay(250);
      const healthStartedAt = Date.now();
      let healthError: Error | null = null;
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(750) });
      } catch (error) {
        healthError = error as Error;
      }
      expect(healthError?.name).toBe('TimeoutError');
      expect(Date.now() - healthStartedAt).toBeGreaterThanOrEqual(700);

      const search = await searchResponse;
      expect(search.ok).toBe(true);
      expect((await search.json()).totalResults).toBe(0);
    } finally {
      await stopFixture(child);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

// 45 distinct words that are in no row, then the one word that is: over 600 characters, so the
// long-prompt rule applies, and the match sits past the 40-token no-vocabulary fallback.
const LONG_PROMPT = Array.from({ length: 45 }, (_, n) => `absentword${String.fromCharCode(97 + (n % 26))}${n}`).join(' ')
  + ' please also find zyzzyva ' + 'context '.repeat(20);
// Three terms with no row holding all of them: widget is in most rows and should be dropped.
const RARE_TERM_QUERY = 'widget zyzzyva nowhereword';

function seedSearchDatabase(directory: string): { store: SessionStore; search: SessionSearch; shortRowId: number; longRowId: number; rareRowId: number } {
  const store = new SessionStore(join(directory, 'claude-mem.db'));
  const sessionA = store.createSDKSession('search-read-a', 'searchproj', 'opening prompt');
  store.ensureMemorySessionIdRegistered(sessionA, 'search-mem-a');
  const shortRow = store.storeObservation('search-mem-a', 'searchproj', {
    type: 'discovery', title: 'quarx', subtitle: null,
    facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
  }, 1, 0, 1_000_000);
  const sessionB = store.createSDKSession('search-read-b', 'searchproj', 'second prompt');
  store.ensureMemorySessionIdRegistered(sessionB, 'search-mem-b');
  const longTitle = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty quarx';
  const longRow = store.storeObservation('search-mem-b', 'searchproj', {
    type: 'discovery', title: longTitle, subtitle: null,
    facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
  }, 1, 0, 2_000_000);
  store.storeSummary('search-mem-a', 'searchproj', {
    request: 'first request about zebras', investigated: 'zebra grazing patterns',
    learned: '', completed: '', next_steps: '', notes: null,
  }, 1, 0, 1_500_000);
  store.saveUserPrompt('search-read-a', 2, 'a later prompt mentioning uniquezebra');
  for (let n = 0; n < 4; n++) {
    store.storeObservation('search-mem-b', 'searchproj', {
      type: 'discovery', title: `widget note ${n}`, subtitle: null,
      facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
    }, 1, 0, 3_000_000 + n);
  }
  const rareRow = store.storeObservation('search-mem-b', 'searchproj', {
    type: 'discovery', title: 'widget zyzzyva', subtitle: null,
    facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
  }, 1, 0, 4_000_000);
  const search = new SessionSearch(join(directory, 'claude-mem.db'));
  return { store, search, shortRowId: shortRow.id, longRowId: longRow.id, rareRowId: rareRow.id };
}

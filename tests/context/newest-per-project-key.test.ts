import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservationsMulti, querySummariesMulti } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

// SessionStart reads the newest N rows per project key from the v63
// (key COLLATE NOCASE, created_at_epoch DESC) indexes instead of fetching every
// matching row and sorting them all.

const config: ContextConfig = {
  totalObservationCount: 3,
  fullObservationCount: 0,
  sessionCount: 1,
  showReadTokens: false,
  showWorkTokens: false,
  showSavingsAmount: false,
  showSavingsPercent: false,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['newest']),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
  mainAgentOnly: true,
};

function seed(store: SessionStore, project: string, title: string, createdAtEpoch: number): void {
  const memorySessionId = `mem-${title}`;
  const sessionDbId = store.createSDKSession(`content-${title}`, project, 'prompt', undefined, 'claude');
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  store.storeObservation(memorySessionId, project, {
    type: 'discovery', title, subtitle: null, facts: [], narrative: 'n',
    concepts: ['newest'], files_read: [], files_modified: [],
  }, 1, 0, createdAtEpoch);
  store.storeSummary(memorySessionId, project, {
    request: title, investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null,
  }, 1, 0, createdAtEpoch);
}

function capturePrepared(db: Database): Array<{ sql: string; params: unknown[] }> {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    (statement as unknown as { all: (...params: unknown[]) => unknown }).all = (...params: unknown[]) => {
      captured.push({ sql, params });
      return all(...(params as []));
    };
    return statement;
  };
  return captured;
}

describe('SessionStart newest rows per project key (v63)', () => {
  function setup(): SessionStore {
    const store = new SessionStore(':memory:');
    seed(store, 'app', 'app-old', 1_000);
    seed(store, 'app', 'app-mid', 3_000);
    seed(store, 'app/wt-merged', 'merged-new', 5_000);
    seed(store, 'App/wt-here', 'here-newest', 6_000);
    seed(store, 'other', 'other-newest', 9_000);
    seed(store, 'other', 'other-old', 2_000);
    store.db.run(`UPDATE observations SET merged_into_project = 'app' WHERE project = 'app/wt-merged'`);
    store.db.run(`UPDATE session_summaries SET merged_into_project = 'app' WHERE project = 'app/wt-merged'`);
    return store;
  }

  it('returns the newest rows across project and merged keys, newest first, once each', () => {
    const store = setup();
    const titles = queryObservationsMulti(store, ['app', 'app/wt-here'], config).map(o => o.title);
    expect(titles).toEqual(['here-newest', 'merged-new', 'app-mid']);

    const requests = querySummariesMulti(store, ['app', 'app/wt-here'], config).map(s => s.request);
    // sessionCount 1 + SUMMARY_LOOKAHEAD rows, newest first, never another project's.
    expect(requests[0]).toBe('here-newest');
    expect(requests).not.toContain('other-newest');
    expect(new Set(requests).size).toBe(requests.length);
  });

  it('a row matching two keys (project and merged_into_project) appears once', () => {
    const store = setup();
    const titles = queryObservationsMulti(store, ['app', 'app/wt-merged'], { ...config, totalObservationCount: 10 })
      .map(o => o.title);
    expect(titles).toEqual(['merged-new', 'app-mid', 'app-old']);
  });

  it('keeps newest rows and indexed seeks when adoption expands beyond 250 keys', () => {
    const store = new SessionStore(':memory:');
    try {
      for (let index = 0; index < 251; index++) seed(store, `app/wt-${index}`, `row-${index}`, (index * 37) % 251 + 1);
      store.db.run("UPDATE observations SET merged_into_project = 'app'");
      store.db.run("UPDATE session_summaries SET merged_into_project = 'app'");
      const adoptedKeys = store.getProjectReadKeys(['app']);
      // Interleave timestamps across batches and repeat a matching key with
      // different casing in the last batch: overlap must not consume the cap.
      const keys = [...adoptedKeys.filter((_, i) => i % 2 === 0), ...adoptedKeys.filter((_, i) => i % 2 === 1), 'APP'];
      const newest = Array.from({ length: 251 }, (_, index) => index).sort((a, b) => (b * 37) % 251 - (a * 37) % 251).map(index => `row-${index}`);
      expect(keys.length).toBeGreaterThan(250);
      const captured = capturePrepared(store.db);
      const observations = queryObservationsMulti(store, keys, config);
      expect(observations.map(row => row.title)).toEqual(newest.slice(0, 3));
      expect(new Set(observations.map(row => row.id)).size).toBe(observations.length);
      const summaries = querySummariesMulti(store, keys, config);
      expect(summaries.map(row => row.request)).toEqual(newest.slice(0, 2));
      expect(new Set(summaries.map(row => row.id)).size).toBe(summaries.length);
      for (const { sql, params } of [...captured]) {
        expect((sql.match(/ UNION /g) ?? []).length).toBeLessThan(500);
        const plan = (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{ detail: string }>).map(row => row.detail).join('\n');
        expect(plan).toContain(sql.includes('FROM observations o') ? 'idx_observations_project_nocase_recent' : 'idx_summaries_project_nocase_recent');
      }
    } finally { store.close(); }
  });

  it('seeks the recency indexes instead of sorting every matching row', () => {
    const store = setup();
    const captured = capturePrepared(store.db);
    queryObservationsMulti(store, ['app', 'app/wt-here'], config);
    querySummariesMulti(store, ['app', 'app/wt-here'], config);
    expect(captured.length).toBe(2);
    const plans = captured.map(({ sql, params }) =>
      (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{ detail: string }>)
        .map(row => row.detail).join('\n'));
    expect(plans[0]).toContain('idx_observations_project_nocase_recent');
    expect(plans[0]).toContain('idx_observations_merged_into_nocase_recent');
    expect(plans[1]).toContain('idx_summaries_project_nocase_recent');
    expect(plans[1]).toContain('idx_summaries_merged_into_nocase_recent');
  });
});

// The user-facing failure: a checkout whose merged worktrees push its read keys
// past 250 (two compound terms per key, SQLite allows 500) threw "too many terms
// in compound SELECT" from SessionStart. Rendered in a child for its own data dir.
const sessionStartFixture = String.raw`
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
  for (let index = 0; index < 251; index++) {
    const project = 'app/wt-' + index;
    const memorySessionId = 'adopted-observer-' + index;
    store.ensureMemorySessionIdRegistered(store.createSDKSession('adopted-host-' + index, project, 'prompt'), memorySessionId);
    const epoch = 1_700_000_000_000 + index * 60_000;
    store.storeObservation(memorySessionId, project, { type: 'discovery', title: 'ADOPTED_ROW_' + index, subtitle: null, facts: [], narrative: 'n', concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1, 0, epoch);
    store.storeSummary(memorySessionId, project, { request: 'ADOPTED_SUMMARY_' + index, investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null }, 1, 0, epoch);
  }
  // Every worktree was merged into the checkout, so its reads adopt all 251 keys.
  store.db.run("UPDATE observations SET merged_into_project = 'app'");
  store.db.run("UPDATE session_summaries SET merged_into_project = 'app'");
  store.close();
  const result = await generateContextWithStats({ projects: ['app'], cwd: '/owned/app' });
  console.log(JSON.stringify({ text: result.text, observations: result.stats?.observation_count ?? 0 }));
`;

describe('SessionStart past 250 adopted project keys', () => {
  it('renders the newest adopted rows instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-start-adopted-keys-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', sessionStartFixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.observations).toBeGreaterThan(0);
      expect(result.text).toContain('ADOPTED_ROW_250');
      expect(result.text).not.toContain('ADOPTED_ROW_0');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});

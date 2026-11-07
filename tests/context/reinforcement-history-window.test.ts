import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { queryObservationsMulti } from './src/services/context/ObservationCompiler.ts';
  import { isoDay } from './src/services/reinforcement/strength.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'reinforce-window', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const now = Date.now(); const DAY = 86400000;
  const make = (title, age) => store.storeObservation('memory', 'reinforce-window', {
    type: 'discovery', title, subtitle: null, narrative: title, facts: [], concepts: ['history-window'], files_read: [], files_modified: []
  }, 1, 0, now - age * DAY).id;
  try {
    const durable = make('TEN_REINFORCEMENTS', 30);
    const competitor = make('NINE_REINFORCEMENTS', 20);
    make('RECENCY_HEAD', 0);
    for (let age = 10; age >= 1; age--) make('TEN_REINFORCEMENTS', age);
    for (let age = 9; age >= 1; age--) make('NINE_REINFORCEMENTS', age);
    const dates = store.db.prepare('SELECT id, reinforcement_dates FROM observations ORDER BY id').all();
    const config = { totalObservationCount: 2, observationTypes: new Set(['discovery']), observationConcepts: new Set(['history-window']), mainAgentOnly: true };
    const ranked = queryObservationsMulti(store, ['reinforce-window'], { ...config, reinforcementAlpha: 1 });
    const legacy = queryObservationsMulti(store, ['reinforce-window'], { ...config, reinforcementAlpha: 0 });
    console.log(JSON.stringify({ dates, durable, competitor, creationDay: isoDay(new Date(now - 30 * DAY)), ranked: ranked.map(o => o.title), legacy: legacy.map(o => o.title) }));
  } finally { store.close(); }
`;

describe('reinforcement ranking after FIFO history eviction', () => {
  it('counts the oldest retained reinforcement once the creation seed has fallen out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reinforcement-window-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      const retained = JSON.parse(result.dates.find((o: { id: number }) => o.id === result.durable).reinforcement_dates);
      expect(result.dates).toHaveLength(3); // duplicate write path reinforced rather than inserted
      expect(retained).toHaveLength(10);
      expect(retained).not.toContain(result.creationDay);
      expect(result.ranked).toEqual(['RECENCY_HEAD', 'TEN_REINFORCEMENTS']);
      expect(result.legacy).toEqual(['RECENCY_HEAD', 'NINE_REINFORCEMENTS']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

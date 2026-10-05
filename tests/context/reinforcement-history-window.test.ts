import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { queryObservationsMulti } from './src/services/context/ObservationCompiler.ts';
  import { parseReinforcementDates, isoDay } from './src/services/reinforcement/strength.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'reinforce-window', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const now = Date.now(); const DAY = 86400000;
  const otherSid = store.createSDKSession('host-other', 'reinforce-window', 'ask');
  store.ensureMemorySessionIdRegistered(otherSid, 'memory-other');
  const make = (title, age, memory = 'memory') => store.storeObservation(memory, 'reinforce-window', {
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
    const merged = make('TEN_REINFORCEMENTS', 30, 'memory-other');
    const backdatedRank = queryObservationsMulti(store, ['reinforce-window'], { ...config, reinforcementAlpha: 1 }).map(o => o.title);
    for (let age = 12; age <= 20; age++) make('TEN_REINFORCEMENTS', age, 'memory-other');
    make('FIRST_POSITION_COMPETITOR', 25);
    for (let age = 12; age <= 20; age++) make('FIRST_POSITION_COMPETITOR', age);
    const finalHistory = store.db.prepare('SELECT reinforcement_dates FROM observations WHERE id = ?').get(durable).reinforcement_dates;
    const firstPositionRank = queryObservationsMulti(store, ['reinforce-window'], { ...config, totalObservationCount: 3, reinforcementAlpha: 1 }).map(o => o.title);
    console.log(JSON.stringify({ dates: dates.map(o => ({ ...o, retained: parseReinforcementDates(o.reinforcement_dates) })), durable, competitor, merged, finalRetained: parseReinforcementDates(finalHistory), finalSeedIndex: JSON.parse(finalHistory).seedIndex, creationDay: isoDay(new Date(now - 30 * DAY)), ranked: ranked.map(o => o.title), legacy: legacy.map(o => o.title), backdatedRank, firstPositionRank }));
  } finally { store.close(); }
`;

describe('reinforcement ranking after FIFO history eviction', () => {
  it('counts the oldest retained reinforcement once the creation seed has fallen out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reinforcement-window-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_DEDUP_ENABLED: 'true' }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      const retained = result.dates.find((o: { id: number }) => o.id === result.durable).retained;
      expect(result.dates).toHaveLength(3); // duplicate write path reinforced rather than inserted
      expect(retained).toHaveLength(10);
      expect(retained).not.toContain(result.creationDay);
      expect(result.ranked).toEqual(['RECENCY_HEAD', 'TEN_REINFORCEMENTS']);
      expect(result.legacy).toEqual(['RECENCY_HEAD', 'NINE_REINFORCEMENTS']);
      expect(result.merged).toBe(result.durable); // cross-session Tier-0 confirmation
      expect(result.backdatedRank).toEqual(['RECENCY_HEAD', 'TEN_REINFORCEMENTS']);
      expect(result.finalRetained).toHaveLength(10);
      expect(result.finalSeedIndex).toBeNull();
      expect(result.finalRetained[0]).toBe(result.creationDay);
      expect(result.firstPositionRank).toEqual(['RECENCY_HEAD', 'NINE_REINFORCEMENTS', 'TEN_REINFORCEMENTS']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

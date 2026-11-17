import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../../src/utils/logger.js';

const RATIO_KEY = 'CLAUDE_MEM_CHROMA_BACKFILL_PAUSE_RATIO';
const project = 'backfill-pacing';
// Each chroma_add_documents call advances the injected clock by this much,
// so a row's write time is exactly WRITE_MS. The injected sleep advances the
// clock by what it slept, as real time would.
const WRITE_MS = 40;

describe('Chroma bulk backfill pacing', () => {
  let store: SessionStore;
  let dir: string;
  let priorDataDir: string | undefined;
  let managerSpy: ReturnType<typeof spyOn>;
  let settingsSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let accepting = true;
  let clock = 0;
  let addCalls = 0;
  let pauses: number[] = [];
  let onPause: ((ms: number) => Promise<void> | void) | null = null;

  function useRatio(value: string | number | undefined) {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    settingsSpy?.mockRestore();
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...defaults,
      ...(value === undefined ? {} : { [RATIO_KEY]: value }),
    }));
  }

  function seed(ids: number[], forProject = project) {
    const insertSession = store.db.prepare(`INSERT INTO sdk_sessions
      (id, content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch)
      VALUES (?, ?, ?, ?, 'claude', '2026-11-01T00:00:00.000Z', 1)`);
    const insertObs = store.db.prepare(`INSERT INTO observations
      (id, memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified,
       prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, 'discovery', ?, ?, '[]', '[]', '[]', '[]', ?, '2026-11-01T00:00:00.000Z', ?)`);
    store.db.transaction(() => {
      for (const id of ids) {
        insertSession.run(id, `sess-${id}`, `mem-${id}`, forProject);
        insertObs.run(id, `mem-${id}`, forProject, `Observation ${id}`, `Narrative ${id}`, id, 1_700_000_000_000 + id);
      }
    })();
    insertSession.finalize();
    insertObs.finalize();
  }

  function liveObservation(id: number) {
    return new ChromaSync(project).syncObservation(id, `mem-${id}`, project, {
      type: 'discovery', title: `Live ${id}`, subtitle: null, facts: [], narrative: `Live narrative ${id}`,
      concepts: [], files_read: [], files_modified: [],
    }, id, 1_700_000_000_000 + id, 'claude');
  }

  beforeEach(() => {
    priorDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), 'chroma-backfill-pacing-'));
    process.env.CLAUDE_MEM_DATA_DIR = dir;
    ChromaSyncState.resetCacheForTests();
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0, titleOnlyRequeued: true, pending: {} });
    store = new SessionStore(':memory:');
    accepting = true;
    clock = 0;
    addCalls = 0;
    pauses = [];
    onPause = null;
    managerSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({
      acceptsMutations: () => accepting,
      callTool: async (tool: string) => {
        if (tool === 'chroma_add_documents') { addCalls += 1; clock += WRITE_MS; }
        return {};
      },
    } as unknown as ChromaMcpManager);
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    useRatio(undefined);
    ChromaSync.setBackfillPacingForTesting({
      now: () => clock,
      sleep: async ms => { pauses.push(ms); clock += ms; await onPause?.(ms); },
    });
  });

  afterEach(() => {
    ChromaSync.setBackfillPacingForTesting(null);
    settingsSpy.mockRestore();
    warnSpy.mockRestore();
    managerSpy.mockRestore();
    store.close();
    ChromaSyncState.resetCacheForTests();
    if (priorDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = priorDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const ratioWarnings = () => warnSpy.mock.calls.filter(call => JSON.stringify(call).includes(RATIO_KEY));

  it('1. waits before every backfill write that follows a written row, for its write time x ratio', async () => {
    seed([1, 2, 3]);
    useRatio('2.5');
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
    expect(addCalls).toBe(3);
    // Nothing follows the last row, so there is no pause after it.
    expect(pauses).toEqual([WRITE_MS * 2.5, WRITE_MS * 2.5]);
  });

  it('1b. defaults to a ratio of 1 when the setting is unset', async () => {
    seed([1, 2]);
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
    expect(pauses).toEqual([WRITE_MS]);
    expect(ratioWarnings()).toHaveLength(0);
  });

  it('2. never pauses when the ratio is 0', async () => {
    seed([1, 2, 3]);
    useRatio('0');
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
    expect(addCalls).toBe(3);
    expect(pauses).toEqual([]);
  });

  it('3. never pauses for live syncObservation writes', async () => {
    await liveObservation(1);
    await liveObservation(2);
    expect(addCalls).toBe(2);
    expect(pauses).toEqual([]);
  });

  it('4. waits only while no row writer is held, so a live write during the pause proceeds', async () => {
    seed([1, 2]);
    let liveFinishedDuringPause = false;
    onPause = async () => {
      const live = liveObservation(1).then(() => true);
      const timeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500));
      liveFinishedDuringPause = await Promise.race([live, timeout]);
    };
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
    expect(pauses.length).toBeGreaterThan(0);
    expect(liveFinishedDuringPause).toBe(true);
    // The live write was not a backfill row: it did not add a pause.
    expect(pauses).toHaveLength(1);
  });

  it('5. stops without processing further rows when shutdown begins during a pause', async () => {
    seed([1, 2, 3]);
    onPause = () => { accepting = false; };
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('shutdown');
    expect(addCalls).toBe(1);
    expect(pauses).toHaveLength(1);
  });

  it('6. falls back to the default with one warning for a non-numeric ratio', async () => {
    seed([1, 2, 3]);
    useRatio('abc');
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
    expect(pauses).toEqual([WRITE_MS, WRITE_MS]);
    expect(ratioWarnings()).toHaveLength(1);
  });

  for (const bad of ['-1', '11']) {
    it(`6. falls back to the default with one warning for out-of-range ratio ${bad}`, async () => {
      seed([1, 2]);
      useRatio(bad);
      expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
      expect(pauses).toEqual([WRITE_MS]);
      expect(ratioWarnings()).toHaveLength(1);
    });
  }

  it('5b. sleeps a long pause in slices and stops as soon as shutdown begins mid-pause', async () => {
    seed([1, 2]);
    useRatio('10');
    // 40ms write x 10 = 400ms per row is one slice; force a long pause with a slow write.
    const slowWriteMs = 5000;
    managerSpy.mockRestore();
    managerSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({
      acceptsMutations: () => accepting,
      callTool: async (tool: string) => {
        if (tool === 'chroma_add_documents') { addCalls += 1; clock += slowWriteMs; }
        return {};
      },
    } as unknown as ChromaMcpManager);
    onPause = () => { if (pauses.length === 2) accepting = false; };
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('shutdown');
    // 50s total pause, sliced at 1s; stopped after the 2nd slice.
    expect(pauses).toEqual([1000, 1000]);
    expect(addCalls).toBe(1);
  });

  it('6. accepts the bound 0 (pacing off) without warning', async () => {
    seed([1]);
    useRatio('0');
    await new ChromaSync(project).ensureBackfilled(project, store);
    expect(pauses).toEqual([]);
    expect(ratioWarnings()).toHaveLength(0);
  });

  it('6. accepts a JSON number ratio from settings.json', async () => {
    seed([1, 2]);
    useRatio(2);
    expect(await new ChromaSync(project).ensureBackfilled(project, store)).toBe('completed');
    expect(pauses).toEqual([WRITE_MS * 2]);
    expect(ratioWarnings()).toHaveLength(0);
  });

  it('6. accepts the bound 10 without warning', async () => {
    seed([1, 2]);
    useRatio('10');
    await new ChromaSync(project).ensureBackfilled(project, store);
    expect(pauses).toEqual([WRITE_MS * 10]);
    expect(ratioWarnings()).toHaveLength(0);
  });

  describe('7. concurrent projects share one backfill pace', () => {
    const projectB = 'backfill-pacing-b';
    const BIG_WRITE_MS = 1000;
    const RATIO = 2;
    let writes: Array<{ start: number; end: number }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    beforeEach(() => {
      writes = [];
      inFlight = 0;
      maxInFlight = 0;
      ChromaSyncState.replace(projectB, { observations: 0, summaries: 0, prompts: 0, titleOnlyRequeued: true, pending: {} });
      managerSpy.mockRestore();
      managerSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({
        acceptsMutations: () => accepting,
        callTool: async (tool: string) => {
          if (tool !== 'chroma_add_documents') return {};
          addCalls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const start = clock;
          await Promise.resolve();
          clock += BIG_WRITE_MS;
          writes.push({ start, end: clock });
          inFlight -= 1;
          return {};
        },
      } as unknown as ChromaMcpManager);
      seed([1, 2, 3], project);
      seed([11, 12, 13], projectB);
    });

    const runBoth = () => Promise.all([
      new ChromaSync(project).ensureBackfilled(project, store),
      new ChromaSync(projectB).ensureBackfilled(projectB, store),
    ]);

    it('never overlaps backfill writes and keeps busy time within span / (1 + ratio)', async () => {
      useRatio(RATIO);
      expect(await runBoth()).toEqual(['completed', 'completed']);
      expect(writes).toHaveLength(6);
      expect(maxInFlight).toBe(1);
      for (let i = 1; i < writes.length; i += 1) {
        expect(writes[i].start).toBeGreaterThanOrEqual(writes[i - 1].end + BIG_WRITE_MS * RATIO);
      }
      const busy = writes.reduce((sum, w) => sum + (w.end - w.start), 0);
      // Span includes the pace owed after the final write, as a following write would wait it out.
      const span = writes[writes.length - 1].end + BIG_WRITE_MS * RATIO - writes[0].start;
      expect(busy).toBeLessThanOrEqual(span / (1 + RATIO));
    });

    it('does not block a live write issued while a backfill waits on the shared pace', async () => {
      useRatio(RATIO);
      let liveFinishedDuringWait = false;
      let issued = false;
      onPause = async () => {
        if (issued) return;
        issued = true;
        const live = liveObservation(99).then(() => true);
        const timeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500));
        liveFinishedDuringWait = await Promise.race([live, timeout]);
      };
      await runBoth();
      expect(issued).toBe(true);
      expect(liveFinishedDuringWait).toBe(true);
    });

    it('releases the turn when the shared wait throws, so a later backfill still runs', async () => {
      useRatio(RATIO);
      let fail = true;
      onPause = () => { if (fail) { fail = false; throw new Error('sleep failed'); } };
      const outcomes = await Promise.allSettled([
        new ChromaSync(project).ensureBackfilled(project, store),
        new ChromaSync(projectB).ensureBackfilled(projectB, store),
      ]);
      expect(outcomes.some(o => o.status === 'rejected')).toBe(true);
      // The turn was not leaked: a fresh backfill gets through instead of hanging.
      const next = new ChromaSync(project).ensureBackfilled(project, store);
      const timeout = new Promise<string>(resolve => setTimeout(() => resolve('hung'), 2000));
      expect(await Promise.race([next, timeout])).not.toBe('hung');
    });

    it('bypasses the shared gate when the ratio is 0', async () => {
      useRatio('0');
      expect(await runBoth()).toEqual(['completed', 'completed']);
      expect(addCalls).toBe(6);
      expect(pauses).toEqual([]);
    });
  });
});

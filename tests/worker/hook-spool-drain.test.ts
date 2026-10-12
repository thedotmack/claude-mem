import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import * as ingestShared from '../../src/services/worker/http/shared.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { drainHookSpool, HookSpoolDrainer } from '../../src/services/worker/hook-spool-drain.js';
import { HookSpool, hookSpoolKeyFor, HOOK_SPOOL_SESSION_END_UNKNOWN_GRACE_MS } from '../../src/shared/hook-spool.js';
import { logger } from '../../src/utils/logger.js';

let spoolDir: string;
let store: SessionStore;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];
let sessionManager: {
  queueObservation: ReturnType<typeof mock>;
  queueSummarize: ReturnType<typeof mock>;
  requestSessionWrapup: ReturnType<typeof mock>;
  getSession: () => undefined;
};
let eventBroadcaster: {
  broadcastObservationQueued: ReturnType<typeof mock>;
  broadcastSummarizeQueued: ReturnType<typeof mock>;
};
let ensureGeneratorRunning: ReturnType<typeof mock>;

function spoolFiles(spool: HookSpool): string[] {
  return readdirSync(spool.directory).filter(name => name.endsWith('.json'));
}

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
  spoolDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-spool-drain-'));
  store = new SessionStore(new Database(':memory:'));
  sessionManager = {
    queueObservation: mock(async () => {}),
    queueSummarize: mock(async () => {}),
    requestSessionWrapup: mock(async () => {}),
    getSession: () => undefined,
  };
  eventBroadcaster = {
    broadcastObservationQueued: mock(() => {}),
    broadcastSummarizeQueued: mock(() => {}),
  };
  ensureGeneratorRunning = mock(async () => {});
  setIngestContext({
    sessionManager: sessionManager as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: eventBroadcaster as any,
    ensureGeneratorRunning,
  });
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  store.close();
  rmSync(spoolDir, { recursive: true, force: true });
});

describe('drainHookSpool', () => {
  it('routes every kind through the same ingest function its HTTP route uses', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    const spies = {
      observation: spyOn(ingestShared, 'ingestObservation'),
      summarize: spyOn(ingestShared, 'ingestSummarize'),
      sessionEnd: spyOn(ingestShared, 'ingestSessionEnd'),
      advisor: spyOn(ingestShared, 'ingestAdvisorCalls'),
    };

    spool.enqueue('observation', {
      contentSessionId: 'session-a', platformSource: 'claude', toolName: 'Bash',
      toolInput: { command: 'ls' }, toolResponse: { stdout: 'x' }, cwd: '/repo', toolUseId: 'toolu_drain_1',
    });
    spool.enqueue('file_edit', {
      contentSessionId: 'session-a', platformSource: 'claude', toolName: 'write_file',
      toolInput: { filePath: '/repo/a.ts', edits: [] }, toolResponse: { success: true }, cwd: '/repo',
    });
    spool.enqueue('advisor_calls', {
      contentSessionId: 'session-a', platformSource: 'claude', cwd: '/repo',
      calls: [{ toolUseId: 'srvtoolu_1', advice: 'Look at the retry budget.', occurredAtEpoch: 1 }],
    });
    spool.enqueue('summarize', { contentSessionId: 'session-a', platformSource: 'claude', lastAssistantMessage: 'done <private>x</private>' });
    spool.enqueue('session_end', { contentSessionId: 'session-a', platformSource: 'claude' });

    const result = await drainHookSpool(spool);

    expect(result).toEqual({ drained: 5, retained: 0, quarantined: 0, expired: 0 });
    expect(spoolFiles(spool)).toEqual([]);

    expect(spies.observation).toHaveBeenCalledTimes(2);
    expect(spies.summarize).toHaveBeenCalledTimes(1);
    expect(spies.sessionEnd).toHaveBeenCalledTimes(1);
    expect(spies.advisor).toHaveBeenCalledTimes(1);

    // Observable effects of the real ingest functions, in spool order.
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(2);
    const sessionDbId = store.findSessionDbIdByContentSessionId('session-a', 'claude');
    expect(sessionDbId).not.toBeNull();
    expect(sessionManager.queueSummarize).toHaveBeenCalledWith(sessionDbId, 'done', 0);
    expect(sessionManager.requestSessionWrapup).toHaveBeenCalledWith(sessionDbId);
    expect(store.getAdvisorCalls(0, 10).items.map(call => call.tool_use_id)).toEqual(['srvtoolu_1']);
    expect(ensureGeneratorRunning).toHaveBeenCalledWith(sessionDbId, 'summarize');

    Object.values(spies).forEach(spy => spy.mockRestore());
  });

  it('keeps summarize and session_end entries whose session is not known yet, then drains them once it is', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('summarize', { contentSessionId: 'late-init', platformSource: 'claude', lastAssistantMessage: 'hello' });
    spool.enqueue('session_end', { contentSessionId: 'late-init', platformSource: 'claude' });

    expect(await drainHookSpool(spool)).toEqual({ drained: 0, retained: 2, quarantined: 0, expired: 0 });
    expect(spoolFiles(spool)).toHaveLength(2);
    expect(sessionManager.queueSummarize).not.toHaveBeenCalled();
    expect(sessionManager.requestSessionWrapup).not.toHaveBeenCalled();

    store.createSDKSession('late-init', 'project', 'prompt', undefined, 'claude');

    expect(await drainHookSpool(spool)).toEqual({ drained: 2, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.queueSummarize).toHaveBeenCalledTimes(1);
    expect(sessionManager.requestSessionWrapup).toHaveBeenCalledTimes(1);
  });

  it('retires a session_end whose session never registered once it passes the grace window; summarize keeps waiting', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    // Both entries are past the unknown-session grace window: the drain asked
    // the worker (up, DB queried) and the session never registered, so the
    // end can never succeed. The summarize's keep is load-bearing — it also
    // waits for an observation to create the session — so it is untouched.
    const staleEpochMs = Date.now() - HOOK_SPOOL_SESSION_END_UNKNOWN_GRACE_MS - 60_000;
    spool.enqueue('session_end', { contentSessionId: 'never-registered', platformSource: 'claude' }, staleEpochMs);
    spool.enqueue('summarize', { contentSessionId: 'never-registered', platformSource: 'claude', lastAssistantMessage: 'hello' }, staleEpochMs);

    expect(await drainHookSpool(spool)).toEqual({ drained: 0, retained: 1, quarantined: 0, expired: 1 });
    expect(spoolFiles(spool)).toEqual([expect.stringMatching(/^summarize-/)]);
    expect(readdirSync(spool.expiredDirectory)).toHaveLength(1);
    expect(sessionManager.requestSessionWrapup).not.toHaveBeenCalled();

    // Inside the grace window the session_end still waits out the init race.
    const fresh = new HookSpool(join(spoolDir, 'spool-fresh'));
    fresh.enqueue('session_end', { contentSessionId: 'another-never-registered', platformSource: 'claude' });
    expect(await drainHookSpool(fresh)).toEqual({ drained: 0, retained: 1, quarantined: 0, expired: 0 });
    expect(spoolFiles(fresh)).toHaveLength(1);
  });

  it('attributes a late-drained observation to the prompt current when the hook saw it, not at drain time', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    const sessionDbId = store.createSDKSession('late-drain', 'project', 'first prompt', undefined, 'claude');
    const hookSawEventAtEpochMs = Date.now() - 1_000;
    store.saveUserPrompt('late-drain', 1, 'first prompt', sessionDbId);
    store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE session_db_id = ?', [hookSawEventAtEpochMs - 1_000, sessionDbId]);

    spool.enqueue('observation', {
      contentSessionId: 'late-drain', platformSource: 'claude', toolName: 'Bash',
      toolInput: { command: 'ls' }, toolResponse: { stdout: 'x' }, cwd: '/repo', toolUseId: 'toolu_late_1',
    }, hookSawEventAtEpochMs);

    // The worker was down; the user moved on two more prompts before it drained.
    store.saveUserPrompt('late-drain', 2, 'second prompt', sessionDbId);
    store.saveUserPrompt('late-drain', 3, 'third prompt', sessionDbId);

    expect(await drainHookSpool(spool)).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
    expect(sessionManager.queueObservation.mock.calls[0][1]).toMatchObject({ prompt_number: 1, toolUseId: 'toolu_late_1' });

    // The HTTP route path (no enqueue time) still means "now".
    await ingestShared.ingestObservation({
      contentSessionId: 'late-drain', platformSource: 'claude', toolName: 'Bash',
      toolInput: { command: 'pwd' }, toolResponse: { stdout: '/' }, cwd: '/repo', toolUseId: 'toolu_live_1',
    });
    expect(sessionManager.queueObservation.mock.calls[1][1]).toMatchObject({ prompt_number: 3, toolUseId: 'toolu_live_1' });
  });

  it('removes a deliberately skipped entry (it would be skipped again)', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    store.createSDKSession('known', 'project', 'prompt', undefined, 'claude');
    spool.enqueue('summarize', { contentSessionId: 'known', platformSource: 'claude', lastAssistantMessage: 'x' });
    const skip = spyOn(ingestShared, 'ingestSummarize').mockResolvedValue({ status: 'skipped', reason: 'private' });

    expect(await drainHookSpool(spool)).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    skip.mockRestore();
  });
});

describe('drainHookSpool exactly-once hand-off across restarts', () => {
  const spoolDirectory = () => join(spoolDir, 'spool');
  const crashObservation = {
    contentSessionId: 'crash-session', platformSource: 'claude', toolName: 'Bash',
    toolInput: { command: 'ls' }, toolResponse: { stdout: 'x' }, cwd: '/repo', toolUseId: 'toolu_crash_1',
  };
  const ENTRY_KEY = `observation-${hookSpoolKeyFor('observation', crashObservation)}`;
  const neverSettles = () => new Promise<never>(() => {});

  async function waitUntil(condition: () => boolean, label: string): Promise<void> {
    for (let tick = 0; tick < 200 && !condition(); tick++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (!condition()) throw new Error(`timed out waiting for: ${label}`);
  }

  it('a worker that dies after markHandedOff (mid generator kick) does not send the entry again', async () => {
    store.createSDKSession('crash-session', 'project', 'prompt', undefined, 'claude');
    new HookSpool(spoolDirectory()).enqueue('observation', crashObservation);

    // Worker 1: the real ingest enqueues and marks the hand-off, then the
    // process "dies" inside the generator kick (the promise never settles),
    // before the drain can unlink the file.
    ensureGeneratorRunning.mockImplementation(neverSettles);
    void drainHookSpool(new HookSpool(spoolDirectory()));
    await waitUntil(() => ensureGeneratorRunning.mock.calls.length === 1, 'generator kick reached');
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
    expect(store.isHookSpoolEntryConsumed(ENTRY_KEY)).toBe(true);
    expect(spoolFiles(new HookSpool(spoolDirectory()))).toEqual([`${ENTRY_KEY}.json`]);

    // Worker 2 boots on the same database and spool directory.
    ensureGeneratorRunning.mockImplementation(async () => {});
    const result = await drainHookSpool(new HookSpool(spoolDirectory()));
    expect(result).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
    expect(spoolFiles(new HookSpool(spoolDirectory()))).toEqual([]);
    expect(store.isHookSpoolEntryConsumed(ENTRY_KEY)).toBe(false);
  });

  it('a worker that dies before markHandedOff (ingest never reaches the enqueue) loses nothing: the next drain ingests it', async () => {
    store.createSDKSession('crash-session', 'project', 'prompt', undefined, 'claude');
    new HookSpool(spoolDirectory()).enqueue('observation', crashObservation);

    // Worker 1 dies while ingest is still resolving the session (before the
    // enqueue, so before markHandedOff).
    const stuckIngest = spyOn(ingestShared, 'ingestObservation').mockImplementation(neverSettles);
    void drainHookSpool(new HookSpool(spoolDirectory()));
    await waitUntil(() => stuckIngest.mock.calls.length === 1, 'ingest entered');
    expect(store.isHookSpoolEntryConsumed(ENTRY_KEY)).toBe(false);
    stuckIngest.mockRestore();

    // Worker 2 boots: the entry is ingested — exactly once.
    const result = await drainHookSpool(new HookSpool(spoolDirectory()));
    expect(result).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
    expect(ensureGeneratorRunning).toHaveBeenCalledTimes(1);
    expect(spoolFiles(new HookSpool(spoolDirectory()))).toEqual([]);
  });

  it('an enqueue that throws leaves no marker and keeps the entry for the next drain', async () => {
    store.createSDKSession('crash-session', 'project', 'prompt', undefined, 'claude');
    const spool = new HookSpool(spoolDirectory());
    spool.enqueue('observation', crashObservation);
    sessionManager.queueObservation.mockImplementationOnce(() => { throw new Error('enqueue failed'); });

    expect(await drainHookSpool(spool)).toEqual({ drained: 0, retained: 1, quarantined: 0, expired: 0 });
    expect(store.isHookSpoolEntryConsumed(ENTRY_KEY)).toBe(false);
    expect(ensureGeneratorRunning).not.toHaveBeenCalled();

    expect(await drainHookSpool(spool)).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(2);
    expect(ensureGeneratorRunning).toHaveBeenCalledTimes(1);
  });

  it('a generator kick that throws after markHandedOff still removes the entry (a retry would send it twice)', async () => {
    store.createSDKSession('crash-session', 'project', 'prompt', undefined, 'claude');
    const spool = new HookSpool(spoolDirectory());
    spool.enqueue('observation', crashObservation);
    ensureGeneratorRunning.mockImplementationOnce(async () => { throw new Error('generator start failed'); });

    expect(await drainHookSpool(spool)).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(await drainHookSpool(spool)).toEqual({ drained: 0, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
  });

  it('marks the hand-off after the enqueue and before ensureGeneratorRunning (observation and summarize)', async () => {
    store.createSDKSession('crash-session', 'project', 'prompt', undefined, 'claude');
    const spool = new HookSpool(spoolDirectory());
    spool.enqueue('observation', crashObservation);
    spool.enqueue('summarize', { contentSessionId: 'crash-session', platformSource: 'claude', lastAssistantMessage: 'done' });
    const summarizeKey = spoolFiles(spool).find(name => name.startsWith('summarize-'))!.replace(/\.json$/, '');

    const markerAt: Record<string, boolean> = {};
    sessionManager.queueObservation.mockImplementation(() => { markerAt.observationEnqueue = store.isHookSpoolEntryConsumed(ENTRY_KEY); });
    sessionManager.queueSummarize.mockImplementation(() => { markerAt.summarizeEnqueue = store.isHookSpoolEntryConsumed(summarizeKey); });
    ensureGeneratorRunning.mockImplementation(async (_sessionDbId: number, source: string) => {
      markerAt[`${source}Kick`] = store.isHookSpoolEntryConsumed(source === 'observation' ? ENTRY_KEY : summarizeKey);
    });

    expect(await drainHookSpool(spool)).toEqual({ drained: 2, retained: 0, quarantined: 0, expired: 0 });
    expect(markerAt).toEqual({
      observationEnqueue: false, observationKick: true,
      summarizeEnqueue: false, summarizeKick: true,
    });
  });

  it('HTTP-route callers (no markHandedOff) ingest unchanged', async () => {
    store.createSDKSession('crash-session', 'project', 'prompt', undefined, 'claude');
    const result = await ingestShared.ingestObservation(crashObservation);
    expect(result).toMatchObject({ ok: true });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
    expect(ensureGeneratorRunning).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM hook_spool_consumed').get()).toEqual({ n: 0 });
  });

  it('a declined entry keeps no marker, so the next drain retries it', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('session_end', { contentSessionId: 'not-yet-known', platformSource: 'claude' });
    expect(await drainHookSpool(spool)).toEqual({ drained: 0, retained: 1, quarantined: 0, expired: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM hook_spool_consumed').get()).toEqual({ n: 0 });
    store.createSDKSession('not-yet-known', 'project', 'prompt', undefined, 'claude');
    expect(await drainHookSpool(spool)).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(sessionManager.requestSessionWrapup).toHaveBeenCalledTimes(1);
  });

  it('prunes markers older than the spool retry window', async () => {
    store.markHookSpoolEntryConsumed('observation-ancient', Date.now() - 8 * 24 * 60 * 60 * 1000);
    store.markHookSpoolEntryConsumed('observation-recent', Date.now() - 60_000);
    await drainHookSpool(new HookSpool(join(spoolDir, 'spool')));
    expect(store.isHookSpoolEntryConsumed('observation-ancient')).toBe(false);
    expect(store.isHookSpoolEntryConsumed('observation-recent')).toBe(true);
  });
});

describe('HookSpoolDrainer', () => {
  it('never runs two drains at once and coalesces requests made during a drain into one more pass', async () => {
    let active = 0;
    let maxActive = 0;
    let passes = 0;
    const releases: Array<() => void> = [];
    const drain = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      passes++;
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
    };
    const drainer = new HookSpoolDrainer(new HookSpool(join(spoolDir, 'spool')), drain);

    const first = drainer.requestDrain();
    drainer.requestDrain();
    drainer.requestDrain();
    drainer.requestDrain();

    releases.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
    releases.shift()!();
    await first;

    expect(maxActive).toBe(1);
    expect(passes).toBe(2);
  });

  it('drains when a hook writes a new spool file (fs.watch)', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    let passes = 0;
    const drainer = new HookSpoolDrainer(spool, async () => { passes++; });
    drainer.start();
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      const passesAfterStart = passes;
      spool.enqueue('session_end', { contentSessionId: 'watched', platformSource: 'claude' });
      const deadline = Date.now() + 2_000;
      while (passes === passesAfterStart && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(passes).toBeGreaterThan(passesAfterStart);
    } finally {
      drainer.stop();
    }
  });
});

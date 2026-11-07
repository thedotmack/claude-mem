import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import * as ingestShared from '../../src/services/worker/http/shared.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { drainHookSpool, HookSpoolDrainer } from '../../src/services/worker/hook-spool-drain.js';
import { HookSpool, hookSpoolKeyFor, HOOK_SPOOL_SESSION_END_UNKNOWN_GRACE_MS } from '../../src/shared/hook-spool.js';
import { logger } from '../../src/utils/logger.js';
import { resolveDeliverableBucketDir } from '../../src/shared/deliverables.js';
import { useTempHookSpoolDataDir } from '../helpers/temp-hook-spool.js';

let spoolDir: string;
let dataDir: ReturnType<typeof useTempHookSpoolDataDir>;
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
  // The deliverables bucket the worker checks copies against lives under the data dir.
  dataDir = useTempHookSpoolDataDir();
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
  dataDir.restore();
  rmSync(spoolDir, { recursive: true, force: true });
});

describe('drainHookSpool', () => {
  it('discards legacy inference while still delivering metadata', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    const spies = {
      observation: spyOn(ingestShared, 'ingestObservation'),
      summarize: spyOn(ingestShared, 'ingestSummarize'),
      sessionEnd: spyOn(ingestShared, 'ingestSessionEnd'),
      advisor: spyOn(ingestShared, 'ingestAdvisorCalls'),
      deliverables: spyOn(ingestShared, 'ingestDeliverables'),
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
    // One copy the hook made on this disk, and one a hook on another host would name: only the first becomes a row.
    const bucketDir = resolveDeliverableBucketDir('repo');
    mkdirSync(bucketDir, { recursive: true });
    const bucketPath = join(bucketDir, 'report-abcdef12.html');
    writeFileSync(bucketPath, '<h1>report</h1>');
    spool.enqueue('deliverables', {
      contentSessionId: 'session-a', platformSource: 'claude', cwd: '/repo', project: 'repo',
      files: [
        { sourcePath: '/repo/.scratch/report.html', bucketPath, title: 'report.html', kind: 'page', bytes: 15, sha256: 'a'.repeat(64), declared: false, occurredAtEpoch: 1 },
        { sourcePath: '/elsewhere/.scratch/deck.pdf', bucketPath: '/elsewhere/.claude-mem/deliverables/repo/deck-01234567.pdf', title: 'deck.pdf', kind: 'document', bytes: 9, sha256: 'b'.repeat(64), declared: true, occurredAtEpoch: 1 },
      ],
      errors: [{ sourcePath: '/repo/.scratch/huge.mov', error: 'over the limit' }],
    });
    spool.enqueue('summarize', { contentSessionId: 'session-a', platformSource: 'claude', lastAssistantMessage: 'done <private>x</private>' });
    spool.enqueue('session_end', { contentSessionId: 'session-a', platformSource: 'claude' });

    const sessionDbId = store.createSDKSession('session-a', 'repo', 'prompt', undefined, 'claude');
    const result = await drainHookSpool(spool);

    expect(result).toEqual({ drained: 6, retained: 0, quarantined: 0, expired: 0 });
    expect(spoolFiles(spool)).toEqual([]);

    expect(spies.observation).not.toHaveBeenCalled();
    expect(spies.summarize).not.toHaveBeenCalled();
    expect(spies.sessionEnd).toHaveBeenCalledTimes(1);
    expect(spies.advisor).toHaveBeenCalledTimes(1);
    expect(spies.deliverables).toHaveBeenCalledTimes(1);

    // Observable effects of the real ingest functions, in spool order.
    expect(sessionManager.queueObservation).not.toHaveBeenCalled();
    expect(sessionDbId).not.toBeNull();
    expect(sessionManager.queueSummarize).not.toHaveBeenCalled();
    expect(sessionManager.requestSessionWrapup).toHaveBeenCalledWith(sessionDbId);
    expect(store.getAdvisorCalls(0, 10).items.map(call => call.tool_use_id)).toEqual(['srvtoolu_1']);
    expect(store.getDeliverable(1)).toMatchObject({ project: 'repo', content_session_id: 'session-a', bucket_path: bucketPath, kind: 'page' });
    expect(store.getDeliverable(2)).toBeNull();
    expect(ensureGeneratorRunning).not.toHaveBeenCalled();

    Object.values(spies).forEach(spy => spy.mockRestore());
  });


  it('never replays legacy inference even if ingest fails or a worker restarts', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    for (const age of [0, 3 * 24 * 60 * 60_000]) {
      spool.enqueue('observation', { contentSessionId: `old-${age}`, platformSource: 'claude',
        toolName: 'Read', toolUseId: `old-${age}`, cwd: '/repo' }, Date.now() - age);
      spool.enqueue('summarize', { contentSessionId: `old-${age}`, platformSource: 'claude',
        lastAssistantMessage: 'old summary' }, Date.now() - age);
    }
    const ingest = spyOn(ingestShared, 'ingestObservation').mockRejectedValue(new Error('provider unavailable'));
    try {
      expect((await drainHookSpool(spool)).drained).toBe(4);
      expect((await drainHookSpool(new HookSpool(spool.directory))).drained).toBe(0);
      expect(ingest).not.toHaveBeenCalled();
      expect(ensureGeneratorRunning).not.toHaveBeenCalled();
    } finally { ingest.mockRestore(); }
  });

  it('retains a session-end metadata event through the init race', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('session_end', { contentSessionId: 'late-init', platformSource: 'claude' });
    expect((await drainHookSpool(spool)).retained).toBe(1);
    store.createSDKSession('late-init', 'project', 'prompt', undefined, 'claude');
    expect((await drainHookSpool(spool)).drained).toBe(1);
    expect(sessionManager.requestSessionWrapup).toHaveBeenCalledTimes(1);
  });

  it('expires unknown session-end metadata after the init grace period', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('session_end', { contentSessionId: 'unknown', platformSource: 'claude' },
      Date.now() - HOOK_SPOOL_SESSION_END_UNKNOWN_GRACE_MS - 1);
    expect((await drainHookSpool(spool)).expired).toBe(1);
    expect(sessionManager.requestSessionWrapup).not.toHaveBeenCalled();
  });

  it('prunes old receipts without calling inference', async () => {
    store.markHookSpoolEntryConsumed('old', Date.now() - 8 * 24 * 60 * 60_000);
    await drainHookSpool(new HookSpool(join(spoolDir, 'spool')));
    expect(store.isHookSpoolEntryConsumed('old')).toBe(false);
    expect(ensureGeneratorRunning).not.toHaveBeenCalled();
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

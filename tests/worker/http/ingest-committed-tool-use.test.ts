import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { logger } from '../../../src/utils/logger.js';

/**
 * The committed-result marker on the live ingest path (the function the
 * transcript processor and the PostToolUse route both call). A tool use whose
 * observer result already committed must never be queued for paid work again,
 * and a lookup that fails must fail toward no spend.
 */
describe('ingestObservation committed tool-use marker', () => {
  let store: SessionStore;
  let queueObservation: ReturnType<typeof mock>;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
    ];
    store = new SessionStore(new Database(':memory:'));
    queueObservation = mock(() => 1);
    setIngestContext({
      sessionManager: { queueObservation } as any,
      dbManager: { getSessionStore: () => store } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    store.close();
  });

  const payload = (overrides: Record<string, unknown> = {}) => ({
    contentSessionId: 'content-committed-1',
    platformSource: 'claude',
    toolName: 'Read',
    toolInput: { file_path: '/repo/a.ts' },
    toolResponse: { ok: true },
    cwd: '/repo',
    toolUseId: 'toolu_committed_01',
    ...overrides,
  });

  it('skips a tool use whose result already committed and does not queue it', async () => {
    store.markCommittedToolUses({
      platformSource: 'claude', contentSessionId: 'content-committed-1', toolUseIds: ['toolu_committed_01'],
    });
    const result = await ingestObservation(payload());
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'already_processed' });
    expect(queueObservation).not.toHaveBeenCalled();
  });

  it('queues a tool use whose marker belongs to another platform', async () => {
    store.markCommittedToolUses({
      platformSource: 'codex', contentSessionId: 'content-committed-1', toolUseIds: ['toolu_committed_01'],
    });
    const result = await ingestObservation(payload());
    expect(result.ok).toBe(true);
    expect(queueObservation).toHaveBeenCalledTimes(1);
  });

  it('still consults the marker when the raw tool_uses backup write fails', async () => {
    store.markCommittedToolUses({
      platformSource: 'claude', contentSessionId: 'content-committed-1', toolUseIds: ['toolu_committed_01'],
    });
    spyOn(store, 'upsertToolUse').mockImplementation(() => { throw new Error('backup unavailable'); });
    const result = await ingestObservation(payload());
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'already_processed' });
    expect(queueObservation).not.toHaveBeenCalled();
  });

  it('skips instead of queueing when the marker lookup fails', async () => {
    spyOn(store, 'hasCommittedToolUse').mockImplementation(() => { throw new Error('lookup unavailable'); });
    const result = await ingestObservation(payload());
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'committed_lookup_failed' });
    expect(queueObservation).not.toHaveBeenCalled();
    expect((loggerSpies[3] as ReturnType<typeof spyOn>).mock.calls
      .some(call => String(call[1]).includes('Committed tool-use lookup failed'))).toBe(true);
  });
});

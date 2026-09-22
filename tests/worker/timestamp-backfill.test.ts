import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { validateClientTimestamp } from '../../src/shared/validate-client-timestamp.js';
import { logger } from '../../src/utils/logger.js';

/**
 * TASK 2 — a client-supplied original event timestamp (transcript backfill)
 * must land as created_at/created_at_epoch on the stored row, instead of
 * Date.now(). A missing/invalid timestamp must fall back to now(), exactly
 * like today's live-hook behavior.
 */
describe('validateClientTimestamp', () => {
  it('accepts a valid ISO string', () => {
    expect(validateClientTimestamp('2024-03-01T12:00:00.000Z')).toBe(Date.parse('2024-03-01T12:00:00.000Z'));
  });

  it('accepts a valid epoch-ms number', () => {
    const epoch = Date.parse('2024-03-01T12:00:00.000Z');
    expect(validateClientTimestamp(epoch)).toBe(epoch);
  });

  it('rejects missing/undefined/empty', () => {
    expect(validateClientTimestamp(undefined)).toBeNull();
    expect(validateClientTimestamp(null)).toBeNull();
    expect(validateClientTimestamp('')).toBeNull();
  });

  it('rejects unparseable strings', () => {
    expect(validateClientTimestamp('not-a-date')).toBeNull();
  });

  it('rejects a date before 2020', () => {
    expect(validateClientTimestamp('2019-12-31T23:59:59.000Z')).toBeNull();
  });

  it('rejects a date more than 5 minutes in the future', () => {
    expect(validateClientTimestamp(new Date(Date.now() + 10 * 60 * 1000).toISOString())).toBeNull();
  });

  it('accepts a date a few seconds in the future (clock skew)', () => {
    const soon = new Date(Date.now() + 30 * 1000).toISOString();
    expect(validateClientTimestamp(soon)).toBe(Date.parse(soon));
  });
});

describe('createSDKSession / saveUserPrompt honor a validated backfill timestamp', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(new Database(':memory:'));
  });

  afterEach(() => {
    store.close();
  });

  it('stamps a new sdk_sessions row with the supplied startedAtEpoch', () => {
    const epoch = Date.parse('2024-03-01T12:00:00.000Z');
    const sessionDbId = store.createSDKSession('content-1', 'proj', 'hi', undefined, 'claude-code', epoch);

    const row = store.db.prepare('SELECT started_at_epoch, started_at FROM sdk_sessions WHERE id = ?')
      .get(sessionDbId) as { started_at_epoch: number; started_at: string };
    expect(row.started_at_epoch).toBe(epoch);
    expect(row.started_at).toBe(new Date(epoch).toISOString());
  });

  it('falls back to now() when no startedAtEpoch is supplied (live hooks unchanged)', () => {
    const before = Date.now();
    const sessionDbId = store.createSDKSession('content-2', 'proj', 'hi', undefined, 'claude-code');
    const after = Date.now();

    const row = store.db.prepare('SELECT started_at_epoch FROM sdk_sessions WHERE id = ?')
      .get(sessionDbId) as { started_at_epoch: number };
    expect(row.started_at_epoch).toBeGreaterThanOrEqual(before);
    expect(row.started_at_epoch).toBeLessThanOrEqual(after);
  });

  it('does not touch started_at_epoch on an already-existing session', () => {
    const firstEpoch = Date.parse('2024-01-01T00:00:00.000Z');
    const sessionDbId = store.createSDKSession('content-3', 'proj', 'hi', undefined, 'claude-code', firstEpoch);

    const laterEpoch = Date.parse('2024-06-01T00:00:00.000Z');
    const sameId = store.createSDKSession('content-3', 'proj', 'hi', undefined, 'claude-code', laterEpoch);
    expect(sameId).toBe(sessionDbId);

    const row = store.db.prepare('SELECT started_at_epoch FROM sdk_sessions WHERE id = ?')
      .get(sessionDbId) as { started_at_epoch: number };
    expect(row.started_at_epoch).toBe(firstEpoch);
  });

  it('stamps a user_prompts row with the supplied createdAtEpoch', () => {
    const epoch = Date.parse('2024-03-01T12:00:00.000Z');
    const sessionDbId = store.createSDKSession('content-4', 'proj', 'hi', undefined, 'claude-code', epoch);
    const promptId = store.saveUserPrompt('content-4', 1, 'hi there', sessionDbId, epoch);

    const row = store.db.prepare('SELECT created_at_epoch FROM user_prompts WHERE id = ?')
      .get(promptId) as { created_at_epoch: number };
    expect(row.created_at_epoch).toBe(epoch);
  });
});

describe('ingestObservation forwards a validated timestamp into the pending message', () => {
  let store: SessionStore | undefined;
  let queued: Array<{ sessionDbId: number; data: any }>;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
    ];

    queued = [];
    store = new SessionStore(new Database(':memory:'));

    setIngestContext({
      sessionManager: {
        queueObservation: async (sessionDbId: number, data: any) => {
          queued.push({ sessionDbId, data });
        },
      } as any,
      dbManager: { getSessionStore: () => store } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    store?.close();
    store = undefined;
  });

  it('validates payload.timestamp and passes it through as clientTimestampEpoch', async () => {
    const epoch = Date.parse('2024-03-01T12:00:00.000Z');
    await ingestObservation({
      contentSessionId: 'content-obs-1',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.ts' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_ts_01',
      timestamp: '2024-03-01T12:00:00.000Z',
    });

    expect(queued).toHaveLength(1);
    expect(queued[0].data.clientTimestampEpoch).toBe(epoch);
  });

  it('drops an invalid timestamp (clientTimestampEpoch is undefined, so live-hook behavior is unchanged)', async () => {
    await ingestObservation({
      contentSessionId: 'content-obs-2',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.ts' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_ts_02',
      timestamp: 'not-a-real-date',
    });

    expect(queued[0].data.clientTimestampEpoch).toBeUndefined();
  });

  it('leaves clientTimestampEpoch undefined when no timestamp is supplied at all', async () => {
    await ingestObservation({
      contentSessionId: 'content-obs-3',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.ts' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_ts_03',
    });

    expect(queued[0].data.clientTimestampEpoch).toBeUndefined();
  });
});

describe('SessionManager.queueObservation/queueSummarize forward client_timestamp_epoch into the pending message buffer', () => {
  let store: SessionStore;
  let sessionManager: SessionManager;

  beforeEach(() => {
    store = new SessionStore(new Database(':memory:'));
    const fakeDbManager = {
      getSessionStore: () => store,
      getSessionById: (id: number) => store.getSessionById(id),
    } as any;
    sessionManager = new SessionManager(fakeDbManager);
  });

  afterEach(() => {
    store.close();
  });

  it('a backfilled observation is stamped with the original time, not enqueue time', async () => {
    const sessionDbId = store.createSDKSession('content-buf-1', 'proj', 'hi', undefined, 'claude-code');
    const epoch = Date.parse('2024-03-01T12:00:00.000Z');

    await sessionManager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: '{}',
      tool_response: '{}',
      prompt_number: 1,
      cwd: '/workspace',
      toolUseId: 'toolu_buf_01',
      clientTimestampEpoch: epoch,
    });

    const buffer = sessionManager.getMessageBuffer();
    const types = buffer.peekTypes(sessionDbId);
    expect(types).toHaveLength(1);

    // Drain one message and confirm _originalTimestamp is the backfilled epoch.
    const controller = new AbortController();
    const iterator = buffer.drain({ sessionDbId, signal: controller.signal });
    const { value } = await iterator.next();
    expect(value?._originalTimestamp).toBe(epoch);
    controller.abort();
  });

  it('a live observation (no client timestamp) is stamped with enqueue time', async () => {
    const sessionDbId = store.createSDKSession('content-buf-2', 'proj', 'hi', undefined, 'claude-code');
    const before = Date.now();

    await sessionManager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: '{}',
      tool_response: '{}',
      prompt_number: 1,
      cwd: '/workspace',
      toolUseId: 'toolu_buf_02',
    });

    const after = Date.now();
    const buffer = sessionManager.getMessageBuffer();
    const controller = new AbortController();
    const iterator = buffer.drain({ sessionDbId, signal: controller.signal });
    const { value } = await iterator.next();
    expect(value?._originalTimestamp).toBeGreaterThanOrEqual(before);
    expect(value?._originalTimestamp).toBeLessThanOrEqual(after);
    controller.abort();
  });
});

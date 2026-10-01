import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { logger } from '../../src/utils/logger.js';

/**
 * Phase 2 contract: one ingest choke point writes BOTH the durable `tool_uses`
 * backup row and the pending_messages → generator queue. Neither may be
 * traded for the other.
 */
describe('ingestObservation dual-write to tool_uses', () => {
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

  const payload = (overrides: Record<string, unknown> = {}) => ({
    contentSessionId: 'content-session-1',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/a.ts' },
    toolResponse: { ok: true },
    cwd: '/workspace/claude-mem',
    toolUseId: 'toolu_dual_01',
    ...overrides,
  });

  it('writes a tool_uses row AND still queues the observation', async () => {
    const result = await ingestObservation(payload());
    expect(result.ok).toBe(true);

    // The generator queue is untouched.
    expect(queued).toHaveLength(1);
    expect(queued[0].data.tool_name).toBe('Read');
    expect(queued[0].data.toolUseId).toBe('toolu_dual_01');

    // The durable backup row exists with the raw payload.
    const rows = store!.queryToolUses({ contentSessionId: 'content-session-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('Read');
    expect(JSON.parse(rows[0].tool_input!)).toEqual({ file_path: '/tmp/a.ts' });
    expect(JSON.parse(rows[0].tool_response!)).toEqual({ ok: true });
    expect(rows[0].session_db_id).toBe(queued[0].sessionDbId);
    expect(rows[0].observation_id).toBeNull();
  });

  it('does not duplicate on replay of the same tool_use_id', async () => {
    await ingestObservation(payload());
    await ingestObservation(payload());

    expect(store!.queryToolUses({ contentSessionId: 'content-session-1' })).toHaveLength(1);
    // The queue still saw both calls; de-duping there is SessionMessageBuffer's job.
    expect(queued).toHaveLength(2);
  });

  it('skips the backup row when no tool_use_id is available, but still ingests', async () => {
    const result = await ingestObservation(payload({ toolUseId: undefined }));

    expect(result.ok).toBe(true);
    expect(queued).toHaveLength(1);
    expect(store!.queryToolUses({})).toHaveLength(0);
  });

  it('stores the Receipt OR join keys when a stamper supplies them', async () => {
    await ingestObservation(payload({
      orGenerationId: 'gen-xyz',
      orSessionId: 'job:content-session-1',
    }));

    const [row] = store!.queryToolUses({});
    expect(row.or_generation_id).toBe('gen-xyz');
    expect(row.or_session_id).toBe('job:content-session-1');
  });

  it('does not back up claude-mem\'s own disclosure tools (no recursion)', async () => {
    await ingestObservation(payload({
      toolName: 'mcp__claude-mem__get_tool_uses',
      toolUseId: 'toolu_recursive',
    }));

    expect(queued).toHaveLength(1);          // observation path is unchanged
    expect(store!.queryToolUses({})).toHaveLength(0);
  });

  it('still backs up another MCP server\'s generic search tool', async () => {
    await ingestObservation(payload({
      toolName: 'mcp__notion__search',
      toolUseId: 'toolu_notion',
    }));

    expect(store!.queryToolUses({})).toHaveLength(1);
  });

  it('queues the observation even if the backup write throws', async () => {
    setIngestContext({
      sessionManager: {
        queueObservation: async (sessionDbId: number, data: any) => { queued.push({ sessionDbId, data }); },
      } as any,
      dbManager: {
        getSessionStore: () => new Proxy(store as any, {
          get(target, prop) {
            if (prop === 'upsertToolUse') return () => { throw new Error('disk full'); };
            const value = (target as any)[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });

    const result = await ingestObservation(payload());

    expect(result.ok).toBe(true);
    expect(queued).toHaveLength(1);
  });
});

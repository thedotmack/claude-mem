import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { logger } from '../../src/utils/logger.js';

/**
 * TASK 1 — secrets must be redacted before an observation's tool input/
 * response reach the pending_messages queue (→ the observer prompt) or the
 * tool_uses backup row (→ SQLite/Chroma), so both the provider and storage
 * only ever see redacted text.
 */
describe('ingestObservation redacts secrets before queueing/storing', () => {
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

  it('redacts a password field in tool_input before it is queued for the observer', async () => {
    await ingestObservation({
      contentSessionId: 'content-session-redact',
      toolName: 'Bash',
      toolInput: { command: 'deploy staging', password: 'hunter2secret' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_redact_01',
    });

    expect(queued).toHaveLength(1);
    const queuedInput = JSON.parse(queued[0].data.tool_input);
    expect(queuedInput.password).toBe('[REDACTED:field:password]');
    expect(JSON.stringify(queuedInput)).not.toContain('hunter2secret');
  });

  it('redacts the same tool_input in the tool_uses backup row (storage side)', async () => {
    await ingestObservation({
      contentSessionId: 'content-session-redact-2',
      toolName: 'Bash',
      toolInput: { note: 'key id is AKIAIOSFODNN7EXAMPLE, keep it safe' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_redact_02',
    });

    const [row] = store!.queryToolUses({ contentSessionId: 'content-session-redact-2' });
    expect(row.tool_input).toContain('[REDACTED:aws_access_key_id]');
    expect(row.tool_input).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('leaves ordinary tool input untouched', async () => {
    await ingestObservation({
      contentSessionId: 'content-session-plain',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.ts' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_plain_01',
    });

    const queuedInput = JSON.parse(queued[0].data.tool_input);
    expect(queuedInput).toEqual({ file_path: '/tmp/a.ts' });
  });
});

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

describe('Kimi bookkeeping tools are skipped for Kimi sessions only', () => {
  let store: SessionStore | undefined;
  let queued: Array<{ sessionDbId: number; data: unknown }>;
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
        queueObservation: async (sessionDbId: number, data: unknown) => {
          queued.push({ sessionDbId, data });
        },
      } as any,
      dbManager: { getSessionStore: () => store } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });
  });

  afterEach(() => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    store?.close();
    store = undefined;
  });

  const payload = (platformSource: string, toolName: string) => ({
    contentSessionId: `content-session-${platformSource}-${toolName}`,
    toolName,
    toolInput: { task_id: 'bg-1' },
    toolResponse: 'still running',
    cwd: '/workspace/claude-mem',
    platformSource,
    toolUseId: `tool-${platformSource}-${toolName}`,
  });

  it('skips TaskOutput and TodoList from a Kimi session', async () => {
    for (const toolName of ['TaskOutput', 'TodoList', 'CronList']) {
      expect(await ingestObservation(payload('kimi', toolName))).toEqual({
        ok: true,
        status: 'skipped',
        reason: 'tool_excluded',
      });
    }
    expect(queued).toHaveLength(0);
  });

  it('still captures the same tool names from Claude Code', async () => {
    const result = await ingestObservation(payload('claude-code', 'TaskOutput'));

    expect(result.ok).toBe(true);
    expect('status' in result).toBe(false);
    expect(queued).toHaveLength(1);
  });

  it('leaves the global CLAUDE_MEM_SKIP_TOOLS default unchanged', () => {
    const skipTools = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_SKIP_TOOLS.split(',');
    expect(skipTools).not.toContain('TaskOutput');
    expect(skipTools).not.toContain('CronList');
  });
});

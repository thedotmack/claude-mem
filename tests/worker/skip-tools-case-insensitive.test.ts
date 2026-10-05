import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

// Adapters rename host tools to the shared vocabulary (OpenCode's `read`
// arrives as `Read`), so CLAUDE_MEM_SKIP_TOOLS has to match without regard to
// case. Otherwise a user's lowercase entry silently stops applying.
describe('CLAUDE_MEM_SKIP_TOOLS matches tool names case-insensitively', () => {
  let store: SessionStore | undefined;
  let queued: Array<{ sessionDbId: number; data: unknown }>;
  let spies: ReturnType<typeof spyOn>[] = [];
  let skipToolsSetting = '';

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
      spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_SKIP_TOOLS: skipToolsSetting,
      })),
    ];
    skipToolsSetting = ' read , bash ';
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
    spies.forEach((spy) => spy.mockRestore());
    store?.close();
    store = undefined;
  });

  const payload = (toolName: string) => ({
    contentSessionId: `content-session-${toolName}`,
    toolName,
    toolInput: { filePath: '/workspace/claude-mem/src/owned.ts' },
    toolResponse: 'ok',
    cwd: '/workspace/claude-mem',
    platformSource: 'opencode',
    toolUseId: `tool-${toolName}`,
  });

  const skipped = { ok: true, status: 'skipped', reason: 'tool_excluded' };

  it('skips Read for a lowercase read entry', async () => {
    expect(await ingestObservation(payload('Read'))).toEqual(skipped);
    expect(queued).toHaveLength(0);
  });

  it('skips Bash for a lowercase bash entry', async () => {
    expect(await ingestObservation(payload('Bash'))).toEqual(skipped);
    expect(queued).toHaveLength(0);
  });

  it('still captures a tool the list does not name', async () => {
    const result = await ingestObservation(payload('Edit'));

    expect(result.ok).toBe(true);
    expect('status' in result).toBe(false);
    expect(queued).toHaveLength(1);
  });

  it('matches a default entry against a host that names the tool in lowercase', async () => {
    // The default list names TodoWrite; OpenCode's own todo tool is `todowrite`.
    skipToolsSetting = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_SKIP_TOOLS;

    expect(await ingestObservation(payload('todowrite'))).toEqual(skipped);
    expect(queued).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupV2, type V2ToolExecuteAfterEvent } from '../../src/integrations/opencode-plugin/v2.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { extractObservationFileEvidence } from '../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// The native execute.after union carries status:error separately from its text:
// https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/promise/tool.ts
describe('OpenCode V2 failed tools through local ingestion', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let sessionId: number;
  let settings: ReturnType<typeof spyOn>;
  let cleanup: () => Promise<void>;
  let capture: (event: V2ToolExecuteAfterEvent) => Promise<void>;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
    });
    store = new SessionStore(new Database(':memory:'), { syncOpsEnabled: false });
    sessionId = store.createSDKSession('opencode-failure', 'project', 'Update the config.', undefined, 'opencode');
    store.saveUserPrompt('opencode-failure', 1, 'Update the config.', sessionId);
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id) };
    manager = new SessionManager(dbManager as never);
    setIngestContext({ dbManager: dbManager as never, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as never,
      ensureGeneratorRunning: async () => {},
    });
    // Every fetch ends at this owned SQLite fixture; no provider is started.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/sessions/observations');
      const body = JSON.parse(String(init?.body));
      const result = await ingestObservation({ contentSessionId: body.contentSessionId,
        platformSource: body.platform_source, cwd: body.cwd, toolName: body.tool_name,
        toolInput: body.tool_input, toolResponse: body.tool_response,
      });
      expect(result.ok).toBe(true);
      return Response.json(result);
    }) as typeof fetch;
    cleanup = await setupV2({ directory: process.cwd(), tool: {
      hook: async (_name, callback) => { capture = callback; return { dispose: async () => {} }; },
    } });
  });

  afterEach(async () => {
    await cleanup();
    globalThis.fetch = originalFetch;
    manager.discardBufferedWork(sessionId);
    store.close();
    settings.mockRestore();
  });

  it.each([
    ['write', { path: 'src/config.ts', content: 'export const configured = true;' }],
    ['edit', { path: 'src/config.ts', oldString: 'false', newString: 'true' }],
  ] as const)('does not record a failed %s as a completed file change', async (tool, input) => {
    await capture({ sessionID: 'opencode-failure', tool, input, status: 'error',
      error: { message: 'Permission denied <private>secret</private>' },
    });
    const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!;
    expect(extractObservationFileEvidence([message]).files_modified).toEqual([]);
    expect(JSON.parse(message.tool_response!)).toEqual({ is_error: true, error: 'Permission denied' });
  });

  it('keeps successful output as text and records the completed file change', async () => {
    await capture({ sessionID: 'opencode-failure', tool: 'write',
      input: { path: 'src/config.ts', content: '{"is_error":true}' }, status: 'completed',
      result: { content: '{"is_error":true}' },
    });
    const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!;
    expect(extractObservationFileEvidence([message]).files_modified).toEqual(['src/config.ts']);
    expect(JSON.parse(message.tool_response!)).toBe('{"is_error":true}');
  });
});

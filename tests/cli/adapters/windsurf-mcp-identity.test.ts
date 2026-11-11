import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windsurfAdapter } from '../../../src/cli/adapters/windsurf.js';
import { observationHandler } from '../../../src/cli/handlers/observation.js';
import { settleHookSpoolNudges } from '../../../src/cli/spool-hook-event.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { resetHookSettingsCacheForTesting } from '../../../src/shared/hook-settings.js';

// The native post_mcp_tool_use envelope carries the server separately from the
// tool's bare name: https://docs.windsurf.com/de/windsurf/cascade/hooks
describe('Windsurf MCP identity through the shared capture path', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let sessionId: number;
  let workspace: string;
  let settings: ReturnType<typeof spyOn>;
  let cwdSpy: ReturnType<typeof spyOn>;
  let requests: string[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'windsurf-mcp-'));
    cwdSpy = spyOn(process, 'cwd').mockReturnValue(workspace);
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
      CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
    });
    resetHookSettingsCacheForTesting();
    store = new SessionStore(new Database(':memory:'), { syncOpsEnabled: false });
    sessionId = store.createSDKSession('windsurf-native', 'project', 'Investigate this issue.', undefined, 'windsurf');
    store.saveUserPrompt('windsurf-native', 1, 'Investigate this issue.', sessionId);
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id) };
    manager = new SessionManager(dbManager as never);
    setIngestContext({ dbManager: dbManager as never, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as never,
      ensureGeneratorRunning: async () => {},
    });
    requests = [];
    // Every request is intercepted, with observation handoffs entering the real
    // local SQLite/RAM ingestion. No worker or provider process is launched.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(url)).pathname;
      requests.push(route);
      expect(route).toBe('/api/sessions/observations');
      const body = JSON.parse(String(init?.body));
      const result = await ingestObservation({ contentSessionId: body.contentSessionId,
        platformSource: body.platformSource, cwd: body.cwd, toolName: body.tool_name,
        toolInput: body.tool_input, toolResponse: body.tool_response,
      });
      return Response.json(result);
    }) as typeof fetch;
  });

  afterEach(async () => {
    await settleHookSpoolNudges();
    globalThis.fetch = originalFetch;
    manager.discardBufferedWork(sessionId);
    store.close();
    settings.mockRestore();
    cwdSpy.mockRestore();
    resetHookSettingsCacheForTesting();
    rmSync(workspace, { recursive: true, force: true });
  });

  function nativeCall(server: string | undefined, tool: string) {
    return windsurfAdapter.normalizeInput({
      trajectory_id: 'windsurf-native', agent_action_name: 'post_mcp_tool_use',
      tool_info: { mcp_server_name: server, mcp_tool_name: tool,
        mcp_tool_arguments: { query: 'existing fix' }, mcp_result: 'Previous investigation details.' },
    });
  }

  it('keeps memory retrieval out of the worker observer queue', async () => {
    for (const tool of ['search', 'timeline', 'get_observations']) {
      const input = nativeCall('claude-mem', tool);
      const result = await ingestObservation({ contentSessionId: input.sessionId,
        platformSource: input.platform, cwd: input.cwd, toolName: input.toolName!,
        toolInput: input.toolInput, toolResponse: input.toolResponse,
      });
      expect(result).toMatchObject({ status: 'skipped', reason: 'memory_retrieval' });
    }
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(0);
  });

  it('applies the hook recursion gate before sending retrieved memory to a worker', async () => {
    await observationHandler.execute(nativeCall('claude-mem', 'search'));
    await settleHookSpoolNudges();
    expect(requests).toEqual([]);
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(0);
  });

  it('captures external same-named searches with their distinct server identities', async () => {
    for (const server of ['github', 'docs']) {
      await observationHandler.execute(nativeCall(server, 'search'));
      await settleHookSpoolNudges();
    }
    expect(requests).toEqual(['/api/sessions/observations', '/api/sessions/observations']);
    const messages = Array.from({ length: 2 }, () => manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!);
    expect(messages.map(message => message.tool_name)).toEqual(['mcp__github__search', 'mcp__docs__search']);
    expect(messages.map(message => JSON.parse(message.tool_input!))).toEqual([
      { query: 'existing fix' }, { query: 'existing fix' },
    ]);
    expect(messages.every(message => JSON.parse(message.tool_response!) === 'Previous investigation details.')).toBe(true);
  });

  it('retains legacy tool names when no server identity was provided', async () => {
    for (const name of ['external_search', 'mcp__github__search']) {
      const input = nativeCall(undefined, name);
      expect(input.toolName).toBe(name);
      await observationHandler.execute(input);
      await settleHookSpoolNudges();
    }
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(2);
  });
});

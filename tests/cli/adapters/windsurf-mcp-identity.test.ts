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
import { ingestHookSpoolEntry } from '../../../src/services/worker/hook-spool-drain.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { loadFromFileOnce, resetHookSettingsCacheForTesting } from '../../../src/shared/hook-settings.js';
import { normalizeRemoteSpoolEntry, remoteSpoolEnvelopeSchema } from '../../../src/shared/hook-spool-remote.js';
import type { SpooledObservationPayload } from '../../../src/shared/hook-spool.js';

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
  let workerEvents: Array<{ tool_name: string; native_tool_name?: string; nativeToolName?: string }>;
  let remoteEvents: SpooledObservationPayload[];
  let serverEvents: Array<{ payload: { tool_name: string } }>;
  let serverStatus: number;
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
    workerEvents = [];
    remoteEvents = [];
    serverEvents = [];
    serverStatus = 200;
    // Every request is intercepted, with observation handoffs entering the real
    // local SQLite/RAM ingestion. No worker or provider process is launched.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(url)).pathname;
      requests.push(route);
      const body = JSON.parse(String(init?.body));
      if (route === '/v1/events') {
        serverEvents.push(body);
        return Response.json({ event: { id: 'fixture-event', projectId: 'fixture-project', serverSessionId: null } }, { status: serverStatus });
      }
      if (route === '/api/spool/ingest') {
        const entry = normalizeRemoteSpoolEntry(remoteSpoolEnvelopeSchema.parse(body).entry);
        expect(entry.kind).toBe('observation');
        remoteEvents.push(entry.payload as SpooledObservationPayload);
        expect(await ingestHookSpoolEntry(entry, () => {})).toBe(true);
        return Response.json({ status: 'accepted' }, { status: 202 });
      }
      expect(route).toBe('/api/sessions/observations');
      workerEvents.push(body);
      const result = await ingestObservation({ contentSessionId: body.contentSessionId,
        platformSource: body.platformSource, cwd: body.cwd, toolName: body.tool_name,
        nativeToolName: body.native_tool_name,
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

  function configureCapture(runtime: 'worker' | 'server', skipTools: string,
    overrides: Partial<ReturnType<typeof SettingsDefaultsManager.getAllDefaults>> = {}) {
    settings.mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_RUNTIME: runtime, CLAUDE_MEM_SKIP_TOOLS: skipTools,
      CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false', CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
      CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:1',
      CLAUDE_MEM_SERVER_API_KEY: 'fixture-key', CLAUDE_MEM_SERVER_PROJECT_ID: 'fixture-project',
      ...overrides,
    });
    resetHookSettingsCacheForTesting();
  }

  async function capture(runtime: 'worker' | 'server', input: ReturnType<typeof nativeCall>) {
    if (runtime === 'server') return observationHandler.execute(input);
    return ingestObservation({ contentSessionId: input.sessionId,
      platformSource: input.platform, cwd: input.cwd, toolName: input.toolName!,
      nativeToolName: input.nativeToolName,
      toolInput: input.toolInput, toolResponse: input.toolResponse,
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

  it('preserves the exact native name through the live worker handoff', async () => {
    configureCapture('worker', 'search');
    for (const tool of ['search', 'search__issues']) {
      await observationHandler.execute(nativeCall('corp__github', tool));
      await settleHookSpoolNudges();
    }
    expect(requests).toEqual(['/api/sessions/observations', '/api/sessions/observations']);
    expect(workerEvents.map(({ tool_name, native_tool_name }) => ({ tool_name, native_tool_name }))).toEqual([
      { tool_name: 'mcp__corp__github__search', native_tool_name: 'search' },
      { tool_name: 'mcp__corp__github__search__issues', native_tool_name: 'search__issues' },
    ]);
    expect(workerEvents.every(event => !Object.hasOwn(event, 'nativeToolName'))).toBe(true);
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(1);
    const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!;
    expect(message.tool_name).toBe('mcp__corp__github__search__issues');
  });

  it('preserves the exact native name through the remote worker envelope', async () => {
    configureCapture('worker', 'search', {
      CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: 'http', CLAUDE_MEM_WORKER_INGEST_TOKEN: 'fixture-token',
    });
    for (const tool of ['search', 'search__issues']) {
      await observationHandler.execute(nativeCall('corp__github', tool));
      await settleHookSpoolNudges();
    }
    expect(requests).toEqual(['/api/spool/ingest', '/api/spool/ingest']);
    expect(remoteEvents.map(({ toolName, nativeToolName }) => ({ toolName, nativeToolName }))).toEqual([
      { toolName: 'mcp__corp__github__search', nativeToolName: 'search' },
      { toolName: 'mcp__corp__github__search__issues', nativeToolName: 'search__issues' },
    ]);
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(1);
    const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!;
    expect(message.tool_name).toBe('mcp__corp__github__search__issues');
  });

  it('retains the native name when a server failure falls back to the worker', async () => {
    configureCapture('server', '');
    serverStatus = 503;
    // The hook has its settings snapshot; the worker reads its current setting
    // independently when the fallback reaches ingestion.
    settings.mockReturnValue({ ...loadFromFileOnce(), CLAUDE_MEM_SKIP_TOOLS: 'search' });
    await observationHandler.execute(nativeCall('corp__github', 'search'));
    await settleHookSpoolNudges();
    expect(requests).toEqual(['/v1/events', '/api/sessions/observations']);
    expect(workerEvents[0]).toMatchObject({ tool_name: 'mcp__corp__github__search', native_tool_name: 'search' });
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(0);
  });

  for (const runtime of ['worker', 'server'] as const) {
    it(`preserves native bare-name exclusions in the ${runtime} capture path`, async () => {
      configureCapture(runtime, ' SEARCH , Search__Issues ');
      for (const server of ['github', 'docs', 'corp__github', undefined]) {
        for (const tool of ['search', 'search__issues']) {
          const input = nativeCall(server, tool);
          // Older clients send only the bare tool name, without the new field.
          if (server === undefined) delete input.nativeToolName;
          const result = await capture(runtime, input);
          if (runtime === 'worker') {
            expect(result).toMatchObject({ status: 'skipped', reason: 'tool_excluded' });
          }
        }
      }
      expect(requests).toEqual([]);
      expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(0);
    });

    it(`keeps qualified exclusions specific to their MCP server in ${runtime} capture`, async () => {
      configureCapture(runtime, ' MCP__GITHUB__Search ');
      const result = await capture(runtime, nativeCall('github', 'search'));
      if (runtime === 'worker') {
        expect(result).toMatchObject({ status: 'skipped', reason: 'tool_excluded' });
      }
      expect(requests).toEqual([]);
      expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(0);

      for (const tool of ['search', 'mcp__github__search']) {
        await capture(runtime, nativeCall('docs', tool));
      }
      const expectedNames = ['mcp__docs__search', 'mcp__docs__mcp__github__search'];
      if (runtime === 'server') {
        expect(requests).toEqual(['/v1/events', '/v1/events']);
        expect(serverEvents.map(event => event.payload.tool_name)).toEqual(expectedNames);
      } else {
        const messages = Array.from({ length: 2 }, () => manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!);
        expect(messages.map(message => message.tool_name)).toEqual(expectedNames);
      }
    });

    it(`does not treat a suffix of a native tool name as an exclusion in ${runtime} capture`, async () => {
      configureCapture(runtime, 'issues, mcp__github__search');
      await capture(runtime, nativeCall('github', 'search__issues'));
      if (runtime === 'server') {
        expect(requests).toEqual(['/v1/events']);
        expect(serverEvents.map(event => event.payload.tool_name)).toEqual(['mcp__github__search__issues']);
      } else {
        const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!;
        expect(message.tool_name).toBe('mcp__github__search__issues');
      }
    });

    it(`leaves other hosts' qualified-name matching unchanged in ${runtime} capture`, async () => {
      configureCapture(runtime, 'search');
      const otherSessionId = store.createSDKSession('cursor-native', 'project', 'Investigate this issue.', undefined, 'cursor');
      store.saveUserPrompt('cursor-native', 1, 'Investigate this issue.', otherSessionId);
      try {
        await capture(runtime, { sessionId: 'cursor-native', platform: 'cursor', cwd: workspace,
          toolName: 'mcp__github__search', toolInput: { query: 'existing fix' }, toolResponse: 'Previous investigation details.' });
        if (runtime === 'server') {
          expect(requests).toEqual(['/v1/events']);
          expect(serverEvents.map(event => event.payload.tool_name)).toEqual(['mcp__github__search']);
        } else {
          const message = manager.getMessageBuffer().claimNextMatching(otherSessionId, () => true)!;
          expect(message.tool_name).toBe('mcp__github__search');
        }
      } finally {
        manager.discardBufferedWork(otherSessionId);
      }
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupV2, type V2ToolExecuteAfterEvent } from '../../src/integrations/opencode-plugin/v2.js';
import { createCore } from '../../src/integrations/opencode-plugin/core.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import type { Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from 'express';
import { extractObservationFileEvidence } from '../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// Released v2.2.7 uses read.path, patch.patchText and shell.command:
// https://github.com/anomalyco/opencode/tree/v2.2.7/packages/core/src/tool/plugin
describe('OpenCode V2 native tool vocabulary through local ingestion', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let sessionId: number;
  let settings: ReturnType<typeof spyOn>;
  let cleanup: () => Promise<void>;
  let capture: (event: V2ToolExecuteAfterEvent) => Promise<void>;
  let results: Array<{ status: string; reason?: string }>;
  let generatorStarts: number;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
      CLAUDE_MEM_SKIP_BASH_PATTERNS: 'scripts/emit_memory\\.py',
    });
    store = new SessionStore(new Database(':memory:'), { syncOpsEnabled: false });
    sessionId = store.createSDKSession('opencode-native-tools', 'project', 'Update the config.', undefined, 'opencode');
    store.saveUserPrompt('opencode-native-tools', 1, 'Update the config.', sessionId);
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id) };
    manager = new SessionManager(dbManager as never);
    setIngestContext({ dbManager: dbManager as never, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as never,
      ensureGeneratorRunning: async () => { generatorStarts++; },
    });
    generatorStarts = 0;
    results = [];
    const routes = new SessionRoutes(manager, dbManager as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never);
    let observationHandlers: RequestHandler[] = [];
    routes.setupRoutes({ get() {}, post(path: string, ...handlers: RequestHandler[]) {
      if (path === '/api/sessions/observations') observationHandlers = handlers;
    } } as never);
    // Run the real HTTP validation/handler chain, ending at owned SQLite and
    // the RAM buffer. Every fetch is intercepted and no provider is started.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/sessions/observations');
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve, reject) => {
        let status = 200;
        const req = { body, headers: {}, query: {}, ip: '127.0.0.1', path: '/api/sessions/observations' } as ExpressRequest;
        const res = { status(code: number) { status = code; return this; }, json(result: { status: string }) {
          results.push(result);
          resolve(Response.json(result, { status }));
        } } as ExpressResponse;
        let index = 0;
        const next = (error?: unknown) => {
          if (error) { reject(error); return; }
          try { observationHandlers[index++]!(req, res, next); } catch (error) { reject(error); }
        };
        next();
      });
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

  async function completed(tool: string, input: Record<string, unknown>, result: unknown = { content: 'Completed.' }) {
    await capture({ sessionID: 'opencode-native-tools', tool, input,
      status: 'completed', result,
    });
    return manager.getMessageBuffer().claimNextMatching(sessionId, () => true);
  }

  it('retains native read.path as completed read evidence without mutating host input', async () => {
    const input = Object.freeze({ path: 'src/config.ts', offset: 1, limit: 20 });
    const message = (await completed('read', input, { content: 'Read file src/config.ts, lines 1-1\n1: export const enabled = true;',
      output: { type: 'text-page', content: 'export const enabled = true;', mime: 'text/plain', offset: 1, truncated: false },
    }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual(['src/config.ts']);
    expect(JSON.parse(message.tool_input!)).toEqual({ file_path: 'src/config.ts', offset: 1, limit: 20 });
    expect(input).toEqual({ path: 'src/config.ts', offset: 1, limit: 20 });
  });

  it.each(['utf8', 'base64'])('retains full native file reads with %s encoding', async encoding => {
    const file = encoding === 'utf8' ? 'assets/example.txt' : 'assets/example.png';
    const mime = encoding === 'utf8' ? 'text/plain' : 'image/png';
    const content = encoding === 'utf8' ? 'owned file text' : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSScAAAAASUVORK5CYII=';
    const message = (await completed('read', { path: file }, {
      output: { type: 'file', uri: `file:///work/project/${file}`, content, encoding, mime },
      content: [{ type: 'text', text: 'File read successfully' }],
    }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([file]);
  });

  it('does not turn a native directory listing into a completed file read', async () => {
    const input = { path: 'src', limit: 20 };
    const message = (await completed('read', input, {
      output: { type: 'list-page', entries: [{ path: 'config.ts', type: 'file' }], truncated: false },
      content: 'Read directory src, entries 1-1\nconfig.ts',
    }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([]);
    expect(JSON.parse(message.tool_input!)).toEqual(input);
  });

  it('keeps a virtual skill URI out of local file evidence', async () => {
    const input = { path: 'skill://review/SKILL.md' };
    const message = (await completed('read', input, {
      output: { type: 'text-page', content: 'Review guidance', mime: 'text/plain', offset: 1, truncated: false },
      content: 'Read file skill://review/SKILL.md, lines 1-1\n1: Review guidance',
    }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([]);
    expect(JSON.parse(message.tool_input!)).toEqual(input);
  });

  it('records files changed by the native patch tool', async () => {
    const input = Object.freeze({ patchText: '*** Begin Patch\n*** Add File: src/config.ts\n+export const enabled = true;\n*** End Patch' });
    const message = (await completed('patch', input))!;
    expect(extractObservationFileEvidence([message]).files_modified).toEqual(['src/config.ts']);
    expect(JSON.parse(message.tool_input!)).toEqual({ patch: input.patchText });
    expect(input).toHaveProperty('patchText');
  });

  it('applies configured command exclusions to the native shell tool', async () => {
    const message = await completed('shell', { command: 'python3 scripts/emit_memory.py' });
    expect(results).toEqual([{ status: 'skipped', reason: 'bash_pattern_excluded' }]);
    expect(message).toBeNull();
  });

  it('continues capturing shell commands outside the excluded pattern', async () => {
    const message = (await completed('shell', { command: 'git status' }))!;
    expect(JSON.parse(message.tool_input!)).toEqual({ command: 'git status' });
    expect(results[0].status).toBe('queued');
  });

  it.each([
    ['patch', 'patch'], ['patch', ' PATCH '], ['patch', 'apply_patch'],
    ['shell', 'shell'], ['shell', ' SHELL '], ['shell', 'Bash'],
  ])('honors %s exclusions configured as %s through the worker route', async (tool, excluded) => {
    settings.mockReturnValue({ ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false', CLAUDE_MEM_SKIP_TOOLS: excluded,
    });
    const input = tool === 'patch'
      ? { patchText: '*** Begin Patch\n*** Add File: src/excluded.ts\n+private work\n*** End Patch' }
      : { command: 'echo private-work' };
    expect(await completed(tool, input)).toBeNull();
    expect(results).toEqual([{ status: 'skipped', reason: 'tool_excluded' }]);
    expect(generatorStarts).toBe(0);
  });

  it('does not treat native shell exclusions as aliases for V1 bash', async () => {
    settings.mockReturnValue({ ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false', CLAUDE_MEM_SKIP_TOOLS: 'shell',
    });
    await createCore({ directory: process.cwd() }).captureTool({ tool: 'bash',
      sessionID: 'opencode-native-tools', args: { command: 'git status' }, output: 'Clean.' });
    const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true);
    expect(message?.tool_name).toBe('Bash');
    expect(results).toEqual([{ status: 'queued' }]);
  });

  it('retains earlier V2 filePath input and does not override a canonical path', async () => {
    const input = { filePath: 'src/real.ts', path: 'src/other.ts' };
    const message = (await completed('read', input))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual(['src/real.ts']);
    expect(JSON.parse(message.tool_input!)).toEqual(input);
  });

  it('does not reinterpret a custom tool with a path argument', async () => {
    const input = { path: 'catalog/item' };
    const message = (await completed('catalog_read', input))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([]);
    expect(JSON.parse(message.tool_input!)).toEqual(input);
  });
});

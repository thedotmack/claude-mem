import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupV2, type V2ToolExecuteAfterEvent } from '../../src/integrations/opencode-plugin/v2.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
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
  let results: Awaited<ReturnType<typeof ingestObservation>>[];
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
      ensureGeneratorRunning: async () => {},
    });
    results = [];
    // All worker requests terminate at owned local SQLite; no provider starts.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/sessions/observations');
      const body = JSON.parse(String(init?.body));
      const result = await ingestObservation({ contentSessionId: body.contentSessionId,
        platformSource: body.platform_source, cwd: body.cwd, toolName: body.tool_name,
        toolInput: body.tool_input, toolResponse: body.tool_response,
      });
      results.push(result);
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
    expect(results).toEqual([{ ok: true, status: 'skipped', reason: 'bash_pattern_excluded' }]);
    expect(message).toBeNull();
  });

  it('continues capturing shell commands outside the excluded pattern', async () => {
    const message = (await completed('shell', { command: 'git status' }))!;
    expect(JSON.parse(message.tool_input!)).toEqual({ command: 'git status' });
    expect(results[0].ok).toBe(true);
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

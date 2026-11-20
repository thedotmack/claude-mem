import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register from '../../omp/hooks/claude-mem.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { extractObservationFileEvidence } from '../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// Native tool names and error state come from ToolResultEvent; read details identify resolved files:
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/extensions/types.ts
describe('OMP native tool semantics through local ingestion', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let sessionId: number;
  let dataDir: string;
  let oldDataDir: string | undefined;
  let settings: ReturnType<typeof spyOn>;
  let handlers: Map<string, Function>;
  let ingests: number;
  let results: Awaited<ReturnType<typeof ingestObservation>>[];
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    oldDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'omp-tool-semantics-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
      CLAUDE_MEM_SKIP_BASH_PATTERNS: 'scripts/emit_memory\\.py',
    });
    store = new SessionStore(new Database(':memory:'), { syncOpsEnabled: false });
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id) };
    manager = new SessionManager(dbManager as never);
    setIngestContext({ dbManager: dbManager as never, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as never,
      ensureGeneratorRunning: async () => {},
    });
    ingests = 0;
    results = [];
    // All requests stop at this owned local store. No provider runs.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      if (route === '/api/sessions/init') {
        sessionId = store.createSDKSession(body.contentSessionId, 'project', body.prompt, undefined, 'omp');
        store.saveUserPrompt(body.contentSessionId, 1, body.prompt, sessionId);
        return Response.json({ sessionDbId: sessionId });
      }
      if (route === '/api/sessions/summarize') return Response.json({ ok: true });
      expect(route).toBe('/api/sessions/observations');
      const result = await ingestObservation({ contentSessionId: body.contentSessionId,
        platformSource: body.platformSource, cwd: body.cwd, toolName: body.tool_name,
        toolInput: body.tool_input, toolResponse: body.tool_response, toolUseId: body.tool_use_id,
      });
      results.push(result);
      ingests++;
      return Response.json(result);
    }) as typeof fetch;
    handlers = new Map();
    register({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
    await handlers.get('session_start')!();
    await handlers.get('before_agent_start')!({ prompt: 'Inspect the config.' }, { cwd: dataDir });
  });

  afterEach(async () => {
    await handlers.get('session_shutdown')!();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    globalThis.fetch = originalFetch;
    if (sessionId) manager.discardBufferedWork(sessionId);
    store.close();
    settings.mockRestore();
    if (oldDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = oldDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function capture(event: Record<string, unknown>) {
    const target = ingests + 1;
    await handlers.get('tool_result')!({
      content: [{ type: 'text', text: 'Completed.' }], isError: false, ...event,
    }, { cwd: dataDir });
    const deadline = Date.now() + 2_000;
    while (ingests < target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    expect(ingests).toBe(target);
    return manager.getMessageBuffer().claimNextMatching(sessionId, () => true);
  }

  it('records the resolved file for a native read with an inline selector', async () => {
    const input = Object.freeze({ path: 'src/config.ts:1-20' });
    const file = join(dataDir, 'src/config.ts');
    const message = (await capture({ toolName: 'read', input, details: { resolvedPath: file } }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([file]);
    expect(JSON.parse(message.tool_input!)).toEqual({ path: input.path, file_path: file });
    expect(input).toEqual({ path: 'src/config.ts:1-20' });
  });

  it('does not infer a file read from a native directory listing', async () => {
    const message = (await capture({ toolName: 'read', input: { path: 'src' },
      details: { resolvedPath: join(dataDir, 'src'), isDirectory: true },
    }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([]);
  });

  it('does not infer a local file from a native URL read', async () => {
    const input = { path: 'https://example.test/document' };
    const message = (await capture({ toolName: 'read', input, details: { kind: 'url', url: input.path } }))!;
    expect(extractObservationFileEvidence([message]).files_read).toEqual([]);
    expect(JSON.parse(message.tool_input!)).toEqual(input);
  });

  it('records a successful native write', async () => {
    const input = { path: 'src/config.ts', content: 'export const enabled = true;' };
    const message = (await capture({ toolName: 'write', input }))!;
    expect(extractObservationFileEvidence([message]).files_modified).toEqual(['src/config.ts']);
  });

  it.each(['write', 'edit'])('retains failed %s status without recording a completed change', async toolName => {
    const message = (await capture({ toolName, input: { path: 'src/config.ts' }, isError: true,
      content: [{ type: 'text', text: 'Permission denied <private>secret</private>' }],
    }))!;
    expect(JSON.parse(message.tool_response!)).toEqual({ is_error: true, error: 'Permission denied ' });
    expect(extractObservationFileEvidence([message]).files_modified).toEqual([]);
  });

  it('applies configured exclusions to native bash commands', async () => {
    const message = await capture({ toolName: 'bash', input: { command: 'python3 scripts/emit_memory.py' } });
    expect(results).toEqual([{ ok: true, status: 'skipped', reason: 'bash_pattern_excluded' }]);
    expect(message).toBeNull();
  });

  it('keeps capturing commands outside the exclusion', async () => {
    const message = (await capture({ toolName: 'bash', input: { command: 'git status' } }))!;
    expect(JSON.parse(message.tool_input!)).toEqual({ command: 'git status' });
  });

  it('keeps custom tools and their inputs unchanged', async () => {
    const input = { path: 'catalog/item' };
    const message = (await capture({ toolName: 'catalog_read', input, details: { resolvedPath: 'not-a-file' } }))!;
    expect(message.tool_name).toBe('catalog_read');
    expect(JSON.parse(message.tool_input!)).toEqual(input);
    expect(extractObservationFileEvidence([message]).files_read).toEqual([]);
  });
});

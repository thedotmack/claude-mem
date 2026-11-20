import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register from '../../omp/hooks/claude-mem.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// Native ToolResultEventBase supplies toolCallId for every tool result:
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/extensions/types.ts
describe('OMP native tool receipts through local ingestion', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let sessionId: number;
  let dataDir: string;
  let oldDataDir: string | undefined;
  let settings: ReturnType<typeof spyOn>;
  let handlers: Map<string, Function>;
  let ingests: number;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    oldDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'omp-receipts-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
    });
    store = new SessionStore(new Database(':memory:'), { syncOpsEnabled: false });
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id) };
    manager = new SessionManager(dbManager as never);
    setIngestContext({ dbManager: dbManager as never, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as never,
      ensureGeneratorRunning: async () => {},
    });
    ingests = 0;
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

  async function capture(id?: string) {
    const target = ingests + 1;
    await handlers.get('tool_result')!({ toolName: 'read', toolCallId: id,
      input: { path: 'src/config.ts' }, content: [{ type: 'text', text: 'export const enabled = true;' }], isError: false,
    }, { cwd: dataDir });
    const deadline = Date.now() + 2_000;
    while (ingests < target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    expect(ingests).toBe(target);
  }

  it('retains raw receipts and deduplicates repeated delivery of one native call', async () => {
    await capture('omp-call-1');
    await capture('omp-call-1');
    await capture('omp-call-2');
    const rows = store.db.query('SELECT tool_use_id, platform_source, tool_input, tool_response FROM tool_uses ORDER BY tool_use_id').all() as any[];
    expect(rows.map(row => row.tool_use_id)).toEqual(['omp-call-1', 'omp-call-2']);
    expect(rows.every(row => row.platform_source === 'omp')).toBe(true);
    expect(JSON.parse(rows[0].tool_input)).toEqual({ path: 'src/config.ts' });
    expect(JSON.parse(rows[0].tool_response)).toBe('export const enabled = true;');
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(2);
  });

  it('keeps capturing a host event without an identity', async () => {
    await capture();
    expect(manager.getMessageBuffer().getPendingCount(sessionId)).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS n FROM tool_uses').get()).toEqual({ n: 0 });
  });
});

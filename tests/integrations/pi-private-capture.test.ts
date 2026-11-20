import { describe, expect, it } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';

async function capturePiResult(content: unknown, isError = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'cmem-pi-private-'));
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  const dbManager = {
    getSessionStore: () => store,
    getSessionById: (id: number) => store.getSessionById(id),
    getCloudSync: () => undefined,
    getChromaSync: () => undefined,
  };
  const manager = new SessionManager(dbManager as any);
  const broadcaster = {
    broadcastNewPrompt() {}, broadcastSessionStarted() {}, broadcastObservationQueued() {},
  };
  const routes = new SessionRoutes(manager, dbManager as any,
    {} as any, {} as any, {} as any, broadcaster as any, {} as any, {} as any);
  routes.ensureGeneratorRunning = async () => {};
  setIngestContext({ sessionManager: manager, dbManager: dbManager as any,
    eventBroadcaster: broadcaster as any, ensureGeneratorRunning: async () => {} });
  let transported: any;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/context/inject', (_req, res) => res.send(''));
  app.use('/api/sessions/observations', (req, _res, next) => { transported = req.body; next(); });
  routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const before = Object.fromEntries(['CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_MEDIA_CAPTURE_ENABLED']
    .map(key => [key, process.env[key]]));
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  process.env.CLAUDE_MEM_WORKER_PORT = String((server.address() as { port: number }).port);
  process.env.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED = 'false';
  const handlers = new Map<string, (...args: any[]) => any>();
  const warnings: string[] = [];
  const user = { role: 'user', content: 'Inspect the output', timestamp: Date.now() };
  const context = { cwd, hasUI: true, ui: { notify: (message: string) => warnings.push(message) },
    sessionManager: { getSessionId: () => 'pi-private-boundary',
      getBranch: () => [{ type: 'message', id: 'pi-native-entry', message: user }] } };
  try {
    extension({ on: (name, handler) => handlers.set(name, handler), registerTool() {} } as PiExtensionAPI);
    await handlers.get('session_start')!({}, context);
    await handlers.get('before_agent_start')!({}, context);
    await handlers.get('context_with_system')!({ messages: [{ role: 'system', content: 'System' }, user] }, context);
    await handlers.get('tool_result')!({ toolName: 'read', input: { path: 'result.txt' },
      toolCallId: 'pi-native-tool', content, isError }, context);
    expect(warnings).toEqual([]);
    const row = store.db.query('SELECT session_db_id, tool_response FROM tool_uses WHERE tool_use_id=?')
      .get('pi-native-tool') as { session_db_id: number; tool_response: string };
    expect(row).toBeTruthy();
    const queued = manager.getMessageBuffer().claimNextMatching(row.session_db_id, () => true);
    expect(queued).toBeTruthy();
    return { transported: transported.tool_response, stored: row.tool_response,
      queued: JSON.parse(queued!.tool_response!) };
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('Pi tool privacy before the transport cap', () => {
  it.each([false, true])('removes a cap-crossing private block before transport, raw storage and inference (failure=%s)', async isError => {
    const secret = 'PRIVATE-PI-EVIDENCE-' + 's'.repeat(100_100);
    const input = [
      { type: 'text', text: 'visible before <private>' + secret },
      { type: 'text', text: '<private>nested secret</private></private> visible after' },
    ];
    const result = await capturePiResult(input, isError);
    expect(JSON.stringify(result).includes('PRIVATE-PI-EVIDENCE-')).toBe(false);
    const expected = isError ? { is_error: true, error: 'visible before  visible after' } : 'visible before  visible after';
    expect(result.transported).toEqual(expected);
    expect(result.stored).toBe(JSON.stringify(expected));
    expect(result.queued).toEqual(expected);
    expect(input[0].text).toContain(secret);
  });

  it('retains literal unclosed tags and the existing public-text cap', async () => {
    const text = 'Explain <private> syntax ' + 'p'.repeat(100_100);
    const result = await capturePiResult(text);
    expect(result.transported).toBe(text.slice(0, 100_000));
    expect(result.stored.startsWith('"Explain <private> syntax ')).toBe(true);
    expect(result.queued).toBe(result.transported);
  });
});

import { expect, it, spyOn } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const DRIVER = `
import json, sys, types
args = json.loads(sys.argv[1])
sys.path.insert(0, args['helpers'])
from hermes_session_driver import install_hermes_stub, load_user_plugin
install_hermes_stub()
plugin = load_user_plugin(args['plugin'])
providers, hooks = [], {}
plugin.register(types.SimpleNamespace(register_memory_provider=providers.append,
    register_hook=lambda name, fn: hooks.setdefault(name, []).append(fn)))
p = providers[0]
p.initialize('hermes-skipped-prompt', platform='cli', cwd=args['cwd'])
def drain():
    assert p._client.flush(3.0)
def tool(receipt):
    for fn in hooks['post_tool_call']:
        fn(tool_name='read_file', args={'path': receipt + '.txt'}, result=receipt,
           session_id='hermes-skipped-prompt', tool_call_id=receipt)
if args['scenario'] != 'first-skipped':
    p.on_turn_start(1, 'Inspect this project')
    drain()
duplicate = args['scenario'] == 'duplicate'
p.on_turn_start(2, 'Inspect this project' if duplicate else '<task-notification>Internal completion</task-notification>')
tool('duplicate-tool' if duplicate else 'skipped-tool')
drain()
if args['scenario'] == 'fresh-turn':
    p.on_turn_start(3, 'Now inspect the next file')
    tool('fresh-tool')
    drain()
p.on_session_end([{'role': 'assistant', 'content': 'Final assistant text'}])
drain()
p.shutdown()
`;

for (const scenario of ['first-skipped', 'skipped-last-turn', 'fresh-turn', 'duplicate']) {
  it(`honors the worker's skipped prompt acknowledgement (${scenario})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cmem-hermes-skipped-'));
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
      CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    }));
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
      getCloudSync: () => undefined, getChromaSync: () => undefined };
    const manager = new SessionManager(db as any);
    const broadcaster = { broadcastNewPrompt() {}, broadcastSessionStarted() {}, broadcastObservationQueued() {}, broadcastSummaryQueued() {} };
    const start = async () => {};
    const routes = new SessionRoutes(manager, db as any, {} as any, {} as any, {} as any,
      broadcaster as any, {} as any, {} as any);
    routes.ensureGeneratorRunning = start;
    setIngestContext({ sessionManager: manager, dbManager: db as any, eventBroadcaster: broadcaster as any,
      ensureGeneratorRunning: start });
    const app = express();
    app.use(express.json());
    const requests: string[] = [];
    const initReplies: any[] = [];
    app.use((req, res, next) => {
      requests.push(req.path);
      if (req.path === '/api/sessions/init') {
        const send = res.json.bind(res);
        res.json = body => { initReplies.push(body); return send(body); };
      }
      next();
    });
    routes.setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      child = Bun.spawn(['python3', '-B', '-c', DRIVER, JSON.stringify({
        helpers: resolve('tests/hermes'), plugin: resolve('hermes/claude-mem'), cwd, scenario,
      })], { env: { ...process.env, CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_DATA_DIR: cwd,
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String((server.address() as { port: number }).port) },
        stdout: 'pipe', stderr: 'pipe' });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit, stderr).toBe(0);
      expect(initReplies.some(reply => reply.skipped === true
        && reply.reason === (scenario === 'duplicate' ? 'duplicate' : 'internal_protocol'))).toBe(true);
      const ids = (store.db.query('SELECT tool_use_id FROM tool_uses ORDER BY id').all() as { tool_use_id: string }[])
        .map(row => row.tool_use_id);
      const expected = scenario === 'fresh-turn' ? ['fresh-tool'] : scenario === 'duplicate' ? ['duplicate-tool'] : [];
      expect(ids).toEqual(expected);
      expect(requests.filter(path => path === '/api/sessions/observations')).toHaveLength(expected.length);
      expect(requests.filter(path => path === '/api/sessions/summarize')).toHaveLength(expected.length);
      expect(manager.getTotalQueueDepth()).toBe(expected.length * 2);
      if (scenario === 'first-skipped') {
        expect((store.db.query('SELECT COUNT(*) n FROM sdk_sessions').get() as { n: number }).n).toBe(0);
      }
    } finally {
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const row of store.db.query('SELECT id FROM sdk_sessions').all() as { id: number }[]) manager.removeSessionImmediate(row.id);
      store.close(); settings.mockRestore(); rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);
}

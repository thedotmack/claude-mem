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
provider = providers[0]
provider.initialize('hermes-native-filter', platform='cli', cwd=args['cwd'])
provider.on_turn_start(1, 'Inspect this project')
for fn in hooks['post_tool_call']:
    fn(tool_name=args['name'], args=args['input'], result='Captured output',
       session_id='hermes-native-filter', tool_call_id='hermes-native-tool')
assert provider._client.flush(3.0)
provider.shutdown()
`;

const cases = [
  { name: 'terminal', input: { command: 'echo secret' }, pattern: 'secret', reason: 'bash_pattern_excluded' },
  { name: 'read_file', input: { path: 'file.txt' }, skip: 'Read', reason: 'tool_excluded' },
  { name: 'write_file', input: { path: 'file.txt', content: 'text' }, skip: 'Write', reason: 'tool_excluded' },
  { name: 'patch', input: { path: 'file.txt', old_string: 'a', new_string: 'b' }, skip: 'Edit', reason: 'tool_excluded' },
  ...['read_file', 'write_file', 'patch'].map(name => ({ name, input: { path: 'session-memory/current.md' }, reason: 'session_memory_meta' })),
  { name: 'terminal', input: { command: 'echo secret' }, skip: 'terminal', reason: 'tool_excluded' },
  { name: 'terminal', input: { command: 'git status' }, pattern: 'secret' },
  { name: 'read_file', input: { path: 'src/main.ts' } },
  { name: 'custom_terminal', input: { command: 'echo secret' }, pattern: 'secret' },
] as Array<{ name: string; input: Record<string, unknown>; pattern?: string; skip?: string; reason?: string }>;

for (const fixture of cases) {
  it(`applies capture filters to native Hermes ${fixture.name}: ${fixture.reason ?? 'allowed'} ${JSON.stringify(fixture.input)}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cmem-hermes-native-'));
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
      CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
      CLAUDE_MEM_SKIP_TOOLS: fixture.skip ?? '', CLAUDE_MEM_SKIP_BASH_PATTERNS: fixture.pattern ?? '',
    }));
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
      getCloudSync: () => undefined, getChromaSync: () => undefined };
    const manager = new SessionManager(db as any);
    const broadcaster = { broadcastNewPrompt() {}, broadcastSessionStarted() {}, broadcastObservationQueued() {} };
    let dispatches = 0;
    const start = async (_sessionId: number, source: string) => {
      if (source !== 'init') dispatches++;
    };
    const routes = new SessionRoutes(manager, db as any, {} as any, {} as any, {} as any,
      broadcaster as any, {} as any, {} as any);
    routes.ensureGeneratorRunning = start;
    setIngestContext({ sessionManager: manager, dbManager: db as any, eventBroadcaster: broadcaster as any,
      ensureGeneratorRunning: start });
    const app = express();
    app.use(express.json());
    const replies: any[] = [];
    app.use('/api/sessions/observations', (_req, res, next) => {
      const send = res.json.bind(res);
      res.json = body => { replies.push(body); return send(body); };
      next();
    });
    routes.setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      child = Bun.spawn(['python3', '-B', '-c', DRIVER, JSON.stringify({
        helpers: resolve('tests/hermes'), plugin: resolve('hermes/claude-mem'), cwd,
        name: fixture.name, input: fixture.input,
      })], { env: { ...process.env, CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_DATA_DIR: cwd,
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String((server.address() as { port: number }).port) },
        stdout: 'pipe', stderr: 'pipe' });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit, stderr).toBe(0);
      expect(replies).toHaveLength(1);
      const rows = store.db.query('SELECT tool_name, tool_input, platform_source FROM tool_uses').all() as any[];
      if (fixture.reason) {
        expect(replies[0]).toMatchObject({ status: 'skipped', reason: fixture.reason });
        expect(rows).toHaveLength(0);
        expect(manager.getTotalQueueDepth()).toBe(0);
        expect(dispatches).toBe(0);
      } else {
        expect(rows).toHaveLength(1);
        expect(rows[0].tool_name).toBe(fixture.name);
        expect(rows[0].platform_source).toBe('hermes');
        expect(JSON.parse(rows[0].tool_input)).toEqual(fixture.input);
        expect(manager.getTotalQueueDepth()).toBe(1);
        expect(dispatches).toBe(1);
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

import { strict as assert } from 'node:assert';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.ts';
import { SessionManager } from '../../../src/services/worker/SessionManager.ts';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.ts';

const scenario = process.argv[2];
const host = scenario === 'ipv4-control' ? '127.0.0.1' : '::1';
const configuredHost = scenario === 'ipv6-bracketed-control' ? '[::1]' : host;
const store = new SessionStore(':memory:');
const db: any = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null };
const manager = new SessionManager(db);
const broadcaster = new Proxy({}, { get: () => () => {} });
const routes = new SessionRoutes(manager, db, {} as any, {} as any, {} as any, broadcaster as any, {} as any, {} as any) as any;
routes.ensureGeneratorRunning = async () => {};
const requests: string[] = [];
const server = Bun.serve({ hostname: host, port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push(path);
  if (path === '/api/context/inject') return new Response('owned IPv6 context');
  assert.equal(path, '/api/sessions/init');
  const body = await request.json();
  return new Promise<Response>(resolve => {
    let status = 200;
    routes.handleSessionInitByClaudeId({ body, query: {}, get() {} }, { headersSent: false, status(code: number) { status = code; return this; }, json(value: any) { resolve(Response.json(value, { status })); } });
  });
}});
const errors: string[] = [];
try {
  const { default: register } = await import(process.env.CLAUDE_MEM_OPENCLAW_MODULE || '../../../openclaw/src/index.ts');
  const hooks = new Map<string, Function>();
  register({ id: 'owned', name: 'owned', source: 'owned', config: {}, pluginConfig: { workerHost: configuredHost, workerPort: server.port, syncMemoryFile: true }, logger: { info() {}, warn(message: string) { errors.push(message); }, error(message: string) { errors.push(message); } }, runtime: { channel: {} }, registerService() {}, registerCommand() {}, on(name: string, handler: Function) { hooks.set(name, handler); } } as any);
  const ctx = { sessionKey: 'owned-ipv6-session', agentId: 'owned-agent', workspaceDir: process.env.CLAUDE_MEM_DATA_DIR! };
  await hooks.get('before_agent_start')!({ prompt: 'owned IPv6 prompt' }, ctx);
  const context = await hooks.get('before_prompt_build')!({ prompt: 'owned IPv6 prompt', messages: [] }, ctx);
  const sessions = store.db.query('SELECT project,user_prompt FROM sdk_sessions').all();
  console.log(JSON.stringify({ scenario, requests, sessions, context, errors }));
  assert.deepEqual(requests, ['/api/sessions/init', '/api/context/inject']);
  assert.equal(sessions.length, 1);
  assert.equal((sessions[0] as any).user_prompt, 'owned IPv6 prompt');
  assert.equal((sessions[0] as any).project, 'openclaw-owned-agent');
  assert.equal(context.appendSystemContext, 'owned IPv6 context');
  assert.equal(errors.length, 0);
} finally {
  for (const row of store.db.query('SELECT id FROM sdk_sessions').all() as { id: number }[]) manager.removeSessionImmediate(row.id);
  server.stop(true); store.close();
}

import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'bun:test';

// Replace only the installer home lookup. Every written file belongs to this child.
const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const ownedHome = join(dataDir, 'home');
let workspace = join(dataDir, 'workspace');
const pluginRoot = join(dataDir, 'plugin');
const sourceRoot = process.cwd();
const event = process.argv[2];
for (const dir of [workspace, join(ownedHome, '.bun', 'bin'), join(pluginRoot, 'scripts')]) {
  mkdirSync(dir, { recursive: true });
}
workspace = realpathSync(workspace);
const os = await import('node:os');
mock.module('os', () => ({ ...os, homedir: () => ownedHome }));
symlinkSync(process.execPath, join(ownedHome, '.bun', 'bin', 'bun'));
process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned context') });
process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
process.env.CLAUDE_MEM_WORKER_PORT = String(server.port);
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false' }));
// The installed absolute command loads the actual adapter and spooling handler.
writeFileSync(join(pluginRoot, 'scripts', 'worker-service.cjs'), `
(async () => {
  const { windsurfAdapter } = await import(${JSON.stringify(join(sourceRoot, 'src/cli/adapters/windsurf.ts'))});
  const { observationHandler } = await import(${JSON.stringify(join(sourceRoot, 'src/cli/handlers/observation.ts'))});
  const { settleHookSpoolNudges } = await import(${JSON.stringify(join(sourceRoot, 'src/cli/spool-hook-event.ts'))});
  const raw = JSON.parse(await Bun.stdin.text());
  await observationHandler.execute(windsurfAdapter.normalizeInput(raw));
  await settleHookSpoolNudges();
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
try {
  const { installWindsurfHooks } = await import('../../../src/services/integrations/WindsurfHooksInstaller.ts');
  process.chdir(workspace);
  assert.equal(await installWindsurfHooks(), 0);
  const config = JSON.parse(readFileSync(join(ownedHome, '.codeium', 'windsurf', 'hooks.json'), 'utf8'));
  const entry = config.hooks[event][0];
  const child = Bun.spawn(['bash', '-c', entry.command], {
    cwd: entry.working_directory ?? workspace,
    env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const toolInfo = event === 'post_run_command' ? { cwd: workspace, command_line: 'echo owned' } : event === 'post_cascade_response' ? { response: 'owned response' } : { mcp_tool_name: 'ownedTool', mcp_tool_arguments: { owned: true }, mcp_result: 'owned result' };
  child.stdin.write(JSON.stringify({ trajectory_id: 'owned-windsurf-session', agent_action_name: event, tool_info: toolInfo }));
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(exit, 0, stdout + stderr);
  const { HookSpool } = await import('../../../src/shared/hook-spool.ts');
  const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.ts');
  const { SessionManager } = await import('../../../src/services/worker/SessionManager.ts');
  const { ingestObservation, setIngestContext } = await import('../../../src/services/worker/http/shared.ts');
  const store = new SessionStore(':memory:');
  const db: any = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null };
  const manager = new SessionManager(db);
  setIngestContext({ dbManager: db, sessionManager: manager, eventBroadcaster: { broadcastObservationQueued() {} } as any, ensureGeneratorRunning: async () => {} });
  try {
    const payloads: unknown[] = [];
    const result = await new HookSpool().drain(async (spooled, handedOff) => {
      assert.equal(spooled.kind, 'observation');
      payloads.push(spooled.payload);
      const reply = await ingestObservation(spooled.payload as any, { markHandedOff: handedOff });
      return reply.ok === true;
    });
    const sessions = store.db.query('SELECT project, cwd, platform_source FROM sdk_sessions').all();
    console.log(JSON.stringify({ entry, result, payloads, sessions }));
    assert.equal(payloads.length, 1);
    assert.equal(result.drained, 1);
    assert.equal((payloads[0] as any).cwd, workspace, 'installed hooks must inherit the active workspace');
    assert.equal((sessions[0] as any).cwd, workspace);
    assert.equal((sessions[0] as any).project, 'workspace');
    assert.equal((sessions[0] as any).platform_source, 'windsurf');
    assert.equal(manager.getTotalQueueDepth(), 1);
  } finally {
    for (const row of store.db.query('SELECT id FROM sdk_sessions').all() as { id: number }[]) manager.removeSessionImmediate(row.id);
    store.close();
  }
} finally {
  process.chdir(sourceRoot);
  server.stop(true);
  mock.restore();
}

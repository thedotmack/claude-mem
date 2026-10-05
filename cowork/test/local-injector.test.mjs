import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../scripts/cmem-hook.mjs', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

function runHook(event, input, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook, event], { env, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const cases = [
  { name: 'disabled cached plugin with unavailable worker', enabled: false, cache: true, worker: 'down', cloud: true },
  { name: 'enabled cached plugin with unavailable worker', enabled: true, cache: true, worker: 'down', cloud: true },
  { name: 'cached plugin with no settings and unavailable worker', cache: true, worker: 'down', cloud: true },
  { name: 'disabled cached plugin with healthy stale worker', enabled: false, cache: true, worker: 'healthy', cloud: true },
  { name: 'enabled cached plugin with healthy worker', enabled: true, cache: true, worker: 'healthy', cloud: false },
  { name: 'healthy manual worker without plugin cache', worker: 'healthy', cloud: false },
  { name: 'cached plugin with unhealthy worker', enabled: true, cache: true, worker: 'unhealthy', cloud: true },
  { name: 'disabled plugin in BOM-prefixed settings', enabled: false, bom: true, cache: true, worker: 'healthy', cloud: true },
  { name: 'no local install or worker', worker: 'down', cloud: true },
];

for (const scenario of cases) {
  test(`Cowork session and agent context: ${scenario.name}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-cowork-injector-'));
    const configDir = join(home, 'claude-config');
    mkdirSync(configDir);
    if (scenario.cache) mkdirSync(join(configDir, 'plugins/cache/thedotmack/claude-mem/13.30.0'), { recursive: true });
    if (scenario.enabled !== undefined) {
      writeFileSync(join(configDir, 'settings.json'), (scenario.bom ? '\uFEFF' : '') + JSON.stringify({
        enabledPlugins: { 'claude-mem@thedotmack': scenario.enabled },
      }));
    }
    const cloudRequests = [];
    const healthRequests = [];
    const cloud = createServer((request, response) => {
      request.resume();
      if (request.url.startsWith('/api/hooks/context')) {
        cloudRequests.push(new URL(request.url, 'http://owned.local'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ context: 'owned prior memory' }));
      } else {
        response.writeHead(202);
        response.end('{}');
      }
    });
    const worker = createServer((request, response) => {
      healthRequests.push(request.url);
      response.writeHead(scenario.worker === 'healthy' ? 200 : 503);
      response.end(JSON.stringify({ status: scenario.worker === 'healthy' ? 'ok' : 'unhealthy' }));
    });
    try {
      const cloudPort = await listen(cloud);
      const workerPort = await listen(worker);
      if (scenario.worker === 'down') await close(worker);
      const env = {
        ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem'), CLAUDE_MEM_WORKER_PORT: String(workerPort),
        CMEM_API_BASE: `http://127.0.0.1:${cloudPort}`, CMEM_API_KEY: 'owned-fixture-key',
        CMEM_USER_ID: 'owned-fixture-user', CMEM_SYNC_HUB_URL: `http://127.0.0.1:${cloudPort}`,
      };
      const input = { session_id: 'owned-session', cwd: '/owned/owned-project' };
      const start = await runHook('context', input, env);
      const agent = await runHook('agent-context', {
        ...input, tool_input: { prompt: 'owned agent task', subagent_type: 'general-purpose' },
      }, env);
      assert.equal(cloudRequests.length, scenario.cloud ? 2 : 0);
      if (scenario.cloud) {
        assert.deepEqual(cloudRequests.map(url => url.searchParams.get('scope')), ['session-start', 'agent']);
        assert.ok(cloudRequests.every(url => url.searchParams.get('project') === 'cmem_work_owned-project'));
        assert.ok(JSON.parse(start).hookSpecificOutput.additionalContext.includes('owned prior memory'));
        const updated = JSON.parse(agent).hookSpecificOutput.updatedInput;
        assert.ok(updated.prompt.includes('owned prior memory'));
        assert.ok(updated.prompt.endsWith('\n\nowned agent task'));
        assert.equal(updated.subagent_type, 'general-purpose');
      } else {
        assert.equal(start, '');
        assert.equal(agent, '');
        if (!scenario.cache) assert.deepEqual(healthRequests, ['/api/health', '/api/health']);
      }
    } finally {
      await close(cloud);
      if (worker.listening) await close(worker);
      rmSync(home, { recursive: true, force: true });
    }
  });
}

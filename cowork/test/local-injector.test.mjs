import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../scripts/cmem-hook.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../../plugin/scripts/bun-runner.js', import.meta.url));
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

// The rule: an agent on a machine with a local claude-mem install never reads
// cmem.ai context, and an agent with no local install reads the cloud. The
// install is an enabled plugin registered in installed_plugins.json with its
// hook and worker files. The worker's health never decides it.
const cases = [
  // No local install: cloud context.
  { name: 'no local install or worker', worker: 'down', cloud: true },
  { name: 'healthy worker without a local install', worker: 'healthy', cloud: true },
  { name: 'enabled cached plugin with unavailable worker', enabled: true, cache: true, worker: 'down', cloud: true },
  { name: 'cached plugin with no settings and unavailable worker', cache: true, worker: 'down', cloud: true },
  { name: 'enabled cached but unregistered plugin with healthy worker', enabled: true, cache: true, worker: 'healthy', cloud: true },
  { name: 'cached plugin with unhealthy worker', enabled: true, cache: true, worker: 'unhealthy', cloud: true },
  { name: 'orphaned cached plugin left by an uninstall', enabled: true, cache: true, files: true, orphaned: true, worker: 'healthy', cloud: true },
  { name: 'registered plugin disabled in settings with unavailable worker', enabled: false, cache: true, registered: true, worker: 'down', cloud: true },
  { name: 'registered plugin disabled in settings with healthy stale worker', enabled: false, cache: true, registered: true, worker: 'healthy', cloud: true },
  { name: 'registered plugin disabled in BOM-prefixed settings', enabled: false, bom: true, cache: true, registered: true, worker: 'healthy', cloud: true },
  // A local install: no cloud context, whatever the worker's state.
  { name: 'enabled registered plugin with healthy worker', enabled: true, cache: true, registered: true, worker: 'healthy', cloud: false },
  { name: 'enabled registered plugin with unavailable worker (cold start)', enabled: true, cache: true, registered: true, worker: 'down', cloud: false },
  { name: 'enabled registered plugin with unhealthy worker', enabled: true, cache: true, registered: true, worker: 'unhealthy', cloud: false },
  { name: 'registered plugin without settings file and unavailable worker', cache: true, registered: true, worker: 'down', cloud: false },
  { name: 'registered plugin with empty settings and healthy worker', settings: {}, cache: true, registered: true, worker: 'healthy', cloud: false },
  { name: 'registered plugin with no plugin entry and healthy worker', settings: {enabledPlugins: {}}, cache: true, registered: true, worker: 'healthy', cloud: false },
  { name: 'registered plugin with malformed settings and unavailable worker', malformedSettings: true, cache: true, registered: true, worker: 'down', cloud: false },
];

for (const scenario of cases) {
  test(`Cowork session and agent context: ${scenario.name}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-cowork-injector-'));
    const configDir = join(home, 'claude-config');
    mkdirSync(configDir);
    const plugin = join(configDir, 'plugins/cache/thedotmack/claude-mem/13.30.0');
    if (scenario.cache) mkdirSync(plugin, { recursive: true });
    if (scenario.files || scenario.registered) {
      mkdirSync(join(plugin, 'hooks'), { recursive: true });
      mkdirSync(join(plugin, 'scripts'), { recursive: true });
      writeFileSync(join(plugin, 'hooks/hooks.json'), '{}');
      writeFileSync(join(plugin, 'scripts/worker-service.cjs'), '// owned injector fixture');
    }
    // An uninstall drops the registry entry, and Claude Code stamps the cache copy it no longer loads.
    if (scenario.orphaned) writeFileSync(join(plugin, '.orphaned_at'), String(Date.now()));
    if (scenario.registered) {
      writeFileSync(join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ installPath: plugin }] } }));
    }
    if (scenario.settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(scenario.settings));
    if (scenario.malformedSettings) writeFileSync(join(configDir, 'settings.json'), '{"enabledPlugins": ');
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
      // bun-runner.js parses settings without stripping a BOM, so it can't see
      // that opt-out; the hook follows src/shared/plugin-state.ts, which can.
      if (scenario.registered && !scenario.bom) {
        // Drive the real local launcher. Node is the explicit runtime boundary
        // for this tiny owned script; no installed plugin or worker is started.
        const fixture = join(home, 'owned-injector.cjs');
        writeFileSync(fixture, 'process.stdout.write("owned injector launched")');
        const launched = await new Promise((resolve, reject) => {
          const child = execFile(process.execPath, [launcher, fixture], {
            env: { ...env, BUN: process.execPath, PATH: dirname(process.execPath) }, timeout: 15000,
          }, (error, stdout, stderr) => error ? reject(Object.assign(error, {stderr})) : resolve(stdout));
          child.stdin.end('{}');
        });
        assert.equal(launched, scenario.enabled === false ? '' : 'owned injector launched');
      }
      const input = { session_id: 'owned-session', cwd: '/owned/owned-project' };
      const start = await runHook('context', input, env);
      const agent = await runHook('agent-context', {
        ...input, tool_input: { prompt: 'owned agent task', subagent_type: 'general-purpose' },
      }, env);
      assert.equal(cloudRequests.length, scenario.cloud ? 2 : 0);
      assert.deepEqual(healthRequests, [], 'worker health must not decide local-first');
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
      }
    } finally {
      await close(cloud);
      if (worker.listening) await close(worker);
      rmSync(home, { recursive: true, force: true });
    }
  });
}

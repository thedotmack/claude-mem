import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { startFixture, killOwnedTree, runChild, childEnvironment } = require('../../scripts/profile-claude-mem-hooks.cjs');
const repo = path.resolve(import.meta.dir, '../..');
const fixtureRoot = path.join(repo, '.local', 'hook-http-regression');

test.skipIf(process.platform !== 'win32')('Codex SessionStart exits cleanly after a real HTTP context read with stdin open', async () => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const ownedRoot = fs.realpathSync(fixtureRoot);
  const runDir = fs.mkdtempSync(path.join(ownedRoot, 'session-'));
  const scripts = path.join(runDir, 'install', 'scripts');
  const install = path.dirname(scripts);
  const project = path.join(runDir, 'project');
  const data = path.join(runDir, 'data');
  const config = path.join(runDir, 'config');
  let fixture: any;
  let cleanup: any;
  try {
    for (const dir of [scripts, path.join(install, 'node_modules'), project, data, config]) fs.mkdirSync(dir, { recursive: true });
    for (const name of ['bun-runner.js', 'hook-service.cjs']) {
      fs.copyFileSync(path.join(repo, 'plugin', 'scripts', name), path.join(scripts, name));
    }
    fs.copyFileSync(path.join(repo, 'plugin', 'package.json'), path.join(install, 'package.json'));
    fs.writeFileSync(path.join(scripts, 'worker-service.cjs'), "throw new Error('full worker must not be loaded');\n");
    const bunTrap = path.join(runDir, 'bun-tripwire.cmd');
    const bunUsed = path.join(runDir, 'bun-used.txt');
    fs.writeFileSync(bunTrap, '@echo off\r\necho invoked>"%~dp0bun-used.txt"\r\nexit /b 97\r\n');
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '37877',
      CLAUDE_MEM_TELEMETRY: 'false', CLAUDE_MEM_PROVIDER: 'none'
    }));

    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8'));
    const command = manifest.hooks.SessionStart[0].hooks[0].commandWindows;
    expect(typeof command).toBe('string');
    const commandFile = path.join(runDir, 'session-start.ps1');
    // Keep the frozen native command intact; propagate its actual status from PowerShell.
    fs.writeFileSync(commandFile, command + '\r\nexit $LASTEXITCODE\r\n');
    fixture = await startFixture(runDir, randomBytes(12).toString('hex'));
    const env = childEnvironment({
      CLAUDE_PLUGIN_ROOT: install, PLUGIN_ROOT: '', CLAUDE_CONFIG_DIR: config,
      CLAUDE_MEM_DATA_DIR: data, CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      BUN: bunTrap,
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '37877',
      CLAUDE_MEM_TELEMETRY: 'false', CLAUDE_MEM_PROVIDER: 'none', DO_NOT_TRACK: '1'
    });
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const raw = await runChild({
      file: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', commandFile],
      cwd: project, env, timeoutMs: 20_000,
      input: JSON.stringify({ session_id: `http-regression-${randomBytes(8).toString('hex')}`, cwd: project, hook_event_name: 'SessionStart', source: 'startup' })
    });
    const detail = JSON.stringify(raw);
    expect(raw.timedOut, detail).toBe(false);
    expect(raw.cleanupFailed, detail).toBe(false);
    expect(raw.overflow, detail).toBe(false);
    expect(raw.exitCode, detail).toBe(0);
    expect(fs.existsSync(bunUsed), detail).toBe(false);
    expect(raw.stderr, detail).not.toMatch(/assertion failed|unhandled|uncaught|hook error|exception/i);
    const output = JSON.parse(raw.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toContain('PROFILE_TIMELINE_CONTEXT');
    const requests = fs.readFileSync(fixture.evidencePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    expect(requests.some((request: any) => request.method === 'GET' && new URL(request.url, 'http://127.0.0.1').pathname === '/api/context/inject')).toBe(true);
  } finally {
    if (fixture) {
      cleanup = await killOwnedTree(fixture.child);
    }
    // Only remove the unique directory created by this test, after resolving its real path.
    const actual = fs.realpathSync(runDir);
    const relative = path.relative(ownedRoot, actual);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`Refusing fixture cleanup outside owned root: ${actual}`);
    }
    if (cleanup && (!cleanup.exited || cleanup.timedOut || cleanup.error || (cleanup.attempted && cleanup.taskkillCode !== 0))) {
      throw new Error(`Fixture cleanup failed: ${JSON.stringify(cleanup)}`);
    }
    fs.rmSync(actual, { recursive: true, force: true });
  }
}, 60_000);

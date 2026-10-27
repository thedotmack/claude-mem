import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Exercises the worker produced by `npm run build` (CI's full `bun test tests`
// step runs after the build). The committed worker only picks up bundled Zod at
// the next release rebuild, so this test stays out of the pre-build
// "Verify committed plugin bundles" step.
describe('Worker bundle is self-contained', () => {
  it.each(['node', 'runner', 'bun'])('captures a real observation via %s without plugin dependencies', (mode) => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'cm-codex-hook-bundle-'));
    try {
      mkdirSync(path.join(sandbox, 'node_modules'));
      const pluginRoot = path.join(sandbox, 'plugin');
      const scripts = path.join(pluginRoot, 'scripts');
      mkdirSync(scripts, { recursive: true });
      for (const name of ['bun-runner.js', 'hook-service.cjs']) {
        cpSync(path.join(projectRoot, 'plugin/scripts', name), path.join(scripts, name));
      }
      // The lightweight route must work without evaluating the full worker.
      writeFileSync(path.join(scripts, 'worker-service.cjs'), 'throw new Error("full worker loaded");');
      cpSync(path.join(projectRoot, 'plugin/package.json'), path.join(pluginRoot, 'package.json'));
      const dataDir = path.join(sandbox, 'data');
      mkdirSync(dataDir);
      writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_RUNTIME: 'worker' }));
      const alias = path.join(sandbox, 'linked-scripts');
      if (mode === 'bun') symlinkSync(scripts, alias, 'junction');
      const commandArgs = mode === 'runner' ? [path.join(scripts, 'bun-runner.js'), path.join(scripts, 'worker-service.cjs')] : [path.join(mode === 'bun' ? alias : scripts, 'hook-service.cjs')];
      const hook = spawnSync(mode === 'bun' ? process.execPath : 'node', [...commandArgs, 'hook', 'codex', 'observation'], {
        cwd: sandbox,
        env: {
          ...process.env,
          BUN: process.execPath,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_CONFIG_DIR: path.join(sandbox, 'config'),
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
          CLAUDE_MEM_WORKER_PORT: '37878',
          CLAUDE_MEM_INTERNAL: '',
          CLAUDE_MEM_DISABLE_TOOL_HOOKS: '',
          CLAUDE_MEM_DISABLE_OBSERVATION: '',
          CLAUDE_MEM_TELEMETRY: 'false',
          DO_NOT_TRACK: '1',
        },
        input: JSON.stringify({ session_id: 'packaged-hook-observation', cwd: sandbox, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'Write-Output fixture' }, tool_response: { stdout: 'Grüße 🙂' } }),
        encoding: 'utf-8',
        timeout: 20_000,
      });
      expect(hook.error).toBeUndefined();
      expect(hook.stderr).toBe('');
      expect(hook.status).toBe(0);
      expect(JSON.parse(hook.stdout)).toEqual({ continue: true });
      const spoolDir = path.join(dataDir, 'state/hook-spool');
      const records = readdirSync(spoolDir).filter(name => name.startsWith('observation-') && name.endsWith('.json'));
      expect(records).toHaveLength(1);
      expect(JSON.parse(readFileSync(path.join(spoolDir, records[0]), 'utf8'))).toMatchObject({
        kind: 'observation', payload: { contentSessionId: 'packaged-hook-observation', toolName: 'Bash', platformSource: 'codex', toolResponse: { stdout: 'Grüße 🙂' } },
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 25_000);

  it('runs a Codex hook from a plugin cache without node_modules', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'cm-codex-bundle-'));
    try {
      // An ancestor node_modules disables Bun's implicit package auto-install.
      mkdirSync(path.join(sandbox, 'node_modules'));
      const pluginRoot = path.join(sandbox, 'cache', 'claude-mem');
      const scripts = path.join(pluginRoot, 'scripts');
      mkdirSync(scripts, { recursive: true });
      for (const script of ['bun-runner.js', 'worker-service.cjs']) {
        cpSync(path.join(projectRoot, 'plugin', 'scripts', script), path.join(scripts, script));
      }
      cpSync(path.join(projectRoot, 'plugin', 'package.json'), path.join(pluginRoot, 'package.json'));
      const dataDir = path.join(sandbox, 'data');
      mkdirSync(dataDir);
      writeFileSync(path.join(dataDir, 'settings.json'), '{}');

      const hook = spawnSync('node', [
        path.join(scripts, 'bun-runner.js'),
        path.join(scripts, 'worker-service.cjs'),
        'hook', 'codex', 'file-context',
      ], {
        cwd: sandbox,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_CONFIG_DIR: path.join(sandbox, 'config'),
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_CODEX_HOOK: '1',
        },
        input: JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: path.join(sandbox, 'example.md') },
        }),
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(hook.stderr).toBe('');
      expect(hook.status).toBe(0);
      expect(JSON.parse(hook.stdout)).toEqual({ continue: true });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 20000);
});

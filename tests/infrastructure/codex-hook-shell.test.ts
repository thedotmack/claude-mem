import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = JSON.parse(readFileSync(new URL('../../plugin/hooks/codex-hooks.json', import.meta.url), 'utf8')).hooks;
const input = JSON.stringify({ prompt: "a quoted 'prompt' with $PATH and $(echo unchanged)" });
const shells = ['sh', 'bash', 'zsh', 'fish'];
const optOutFlags = [
  'CLAUDE_MEM_DISABLE_TOOL_HOOKS',
  'CLAUDE_MEM_DISABLE_FILE_CONTEXT',
  'CLAUDE_MEM_DISABLE_OBSERVATION',
];
let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "codex hook's "));
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'node_modules'));
  writeFileSync(join(fixture, 'scripts', 'worker-service.cjs'), '');
  writeFileSync(join(fixture, 'scripts', 'bun-runner.js'), `
    const fs = require('node:fs');
    process.stdout.write(JSON.stringify({
      input: fs.readFileSync(0, 'utf8'),
      args: process.argv.slice(2),
      codex: process.env.CLAUDE_MEM_CODEX_HOOK,
    }));
    process.exit(Number(process.env.CLAUDE_MEM_TEST_HOOK_EXIT || 0));
  `);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function run(shell: string, event: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: fixture,
    PLUGIN_ROOT: fixture,
    CLAUDE_CONFIG_DIR: join(fixture, 'config'),
    SHELL: shell,
  };
  for (const flag of optOutFlags) delete env[flag];
  return spawnSync(shell, [...(shell.endsWith('fish') ? ['--no-config'] : []), '-c', hooks[event][0].hooks[0].command], {
    env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 10000,
  });
}

for (const name of shells) {
  const shell = process.platform === 'win32' ? null : Bun.which(name);
  describe.skipIf(!shell)(`Codex hooks launched by ${name}`, () => {
    for (const [event, handler] of [
      ['SessionStart', 'context'],
      ['UserPromptSubmit', 'session-init'],
      ['PreToolUse', 'file-context'],
      ['PostToolUse', 'observation'],
      ['Stop', 'summarize'],
      ['PostCompact', 'post-compact'],
    ]) {
      test(`${event} preserves stdin, arguments and environment`, () => {
        const result = run(shell!, event);
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          input,
          args: [join(fixture, 'scripts', 'worker-service.cjs'), 'hook', 'codex', handler],
          codex: '1',
        });
      });
    }

    for (const [event, flag] of [
      ['PreToolUse', 'CLAUDE_MEM_DISABLE_TOOL_HOOKS'],
      ['PreToolUse', 'CLAUDE_MEM_DISABLE_FILE_CONTEXT'],
      ['PostToolUse', 'CLAUDE_MEM_DISABLE_TOOL_HOOKS'],
      ['PostToolUse', 'CLAUDE_MEM_DISABLE_OBSERVATION'],
    ]) {
      test(`${event} honors ${flag} before starting Node`, () => {
        const result = run(shell!, event, { [flag]: '1' });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('');
      });
    }

    test('preserves a failing hook exit status', () => {
      const result = run(shell!, 'UserPromptSubmit', { CLAUDE_MEM_TEST_HOOK_EXIT: '17' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(17);
      expect(JSON.parse(result.stdout).input).toBe(input);
    });
  });
}

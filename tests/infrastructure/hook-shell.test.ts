import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quote } from 'shell-quote';
import { buildShellCommand } from '../../src/build/hook-shell-template.js';

const hooks = JSON.parse(readFileSync(new URL('../../plugin/hooks/codex-hooks.json', import.meta.url), 'utf8')).hooks;
const setup = JSON.parse(readFileSync(new URL('../../plugin/hooks/hooks.json', import.meta.url), 'utf8')).hooks.Setup[0].hooks[0].command;
const input = JSON.stringify({ prompt: "a quoted 'prompt' with $PATH and $(echo unchanged)" });
const gitBash = 'C:/Program Files/Git/bin/bash.exe';
const shells = process.platform === 'win32'
  ? [{ name: 'Git Bash', executable: existsSync(gitBash) ? gitBash : null }]
  : ['sh', 'bash', 'zsh', 'fish'].map(name => ({ name, executable: Bun.which(name) }));
const optOutFlags = [
  'CLAUDE_MEM_DISABLE_TOOL_HOOKS',
  'CLAUDE_MEM_DISABLE_FILE_CONTEXT',
  'CLAUDE_MEM_DISABLE_OBSERVATION',
];
let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "hook's $(echo unchanged) "));
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'node_modules'));
  writeFileSync(join(fixture, 'scripts', 'worker-service.cjs'), '');
  const probe = `
    const fs = require('node:fs');
    process.stdout.write(JSON.stringify({
      input: fs.readFileSync(0, 'utf8'),
      args: process.argv.slice(2),
      codex: process.env.CLAUDE_MEM_CODEX_HOOK ?? null,
    }));
    process.exit(Number(process.env.CLAUDE_MEM_TEST_HOOK_EXIT || 0));
  `;
  writeFileSync(join(fixture, 'scripts', 'bun-runner.js'), probe);
  writeFileSync(join(fixture, 'scripts', 'version-check.js'), probe);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function run(shell: string, command: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: fixture,
    PLUGIN_ROOT: fixture,
    CLAUDE_CONFIG_DIR: join(fixture, 'config'),
    SHELL: shell,
  };
  for (const flag of optOutFlags) delete env[flag];
  delete env.CLAUDE_MEM_CODEX_HOOK;
  for (const [name, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync(shell, [...(shell.endsWith('fish') ? ['--no-config'] : []), '-c', command], {
    env, input, encoding: 'utf8', timeout: 10000,
  });
}

for (const { name, executable: shell } of shells) {
  describe.skipIf(!shell)(`Hooks launched by ${name}`, () => {
    test('Setup preserves stdin, arguments and environment', () => {
      const result = run(shell!, setup);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ input, args: [], codex: null });
    });

    test('Setup falls back to the plugin cache when no plugin root is set', () => {
      const cacheRoot = join(fixture, 'config', 'plugins', 'cache', 'thedotmack', 'claude-mem', '99.0.0');
      mkdirSync(join(cacheRoot, 'scripts'), { recursive: true });
      writeFileSync(join(cacheRoot, 'scripts', 'version-check.js'), readFileSync(join(fixture, 'scripts', 'version-check.js')));
      const result = run(shell!, setup, { CLAUDE_PLUGIN_ROOT: undefined, PLUGIN_ROOT: undefined });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ input, args: [], codex: null });
    });

    // Git Bash's runtime re-parses its Windows command line and collapses `\\`
    // to `\` inside quotes, so a backslash pair cannot survive `bash -c` on
    // Windows whatever the generator emits. The generated hooks contain none
    // (asserted below); this quoting check runs on the POSIX shells, Fish included.
    for (const host of ['claude-code-setup', 'codex-cli'] as const) {
      test.skipIf(process.platform === 'win32')(`${host} preserves literal apostrophes, backslashes and metacharacters in the hook body`, () => {
        const payload = String.raw`a 'quote', two\\backslashes, four\\\\backslashes, $PATH and $(echo unchanged)`;
        const command = buildShellCommand({
          host, requireFile: 'version-check.js', notFoundMessage: 'missing fixture',
          trailingCommand: ['printf', "'%s'", quote([payload])],
        });
        const result = run(shell!, command);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe(payload);
      });
    }

    // Windows runs Codex's commandWindows overrides; its POSIX commands are not used there.
    if (process.platform === 'win32') return;
    for (const [event, handler] of [
      ['SessionStart', 'context'],
      ['UserPromptSubmit', 'session-init'],
      ['PreToolUse', 'file-context'],
      ['PostToolUse', 'observation'],
      ['Stop', 'summarize'],
      ['PostCompact', 'post-compact'],
    ]) {
      test(`${event} preserves stdin, arguments and environment`, () => {
        const result = run(shell!, hooks[event][0].hooks[0].command);
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
        const result = run(shell!, hooks[event][0].hooks[0].command, { [flag]: '1' });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('');
      });
    }

    test('preserves a failing hook exit status', () => {
      const result = run(shell!, hooks.UserPromptSubmit[0].hooks[0].command, { CLAUDE_MEM_TEST_HOOK_EXIT: '17' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(17);
      expect(JSON.parse(result.stdout).input).toBe(input);
    });
  });
}

// Escaping every backslash put `\\` pairs into the hooks (from the cache
// scan's printf `\n`), and Git Bash collapses those to `\` on Windows, which
// broke the cache-scan fallback there. Only a backslash before a backslash or
// a quote needs escaping, and no generated hook has one.
test('generated shell-form hooks contain no backslash pairs', () => {
  const commands: string[] = [setup];
  for (const entries of Object.values(hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
    for (const entry of entries) commands.push(...entry.hooks.map(hook => hook.command));
  }
  // Setup plus the seven Codex hooks.
  expect(commands.length).toBe(8);
  for (const command of commands) {
    expect(command.startsWith("/bin/sh -c '")).toBe(true);
    expect(command).not.toContain('\\\\');
  }
});

test('escapes a backslash only before a backslash, a quote or the end', () => {
  const command = buildShellCommand({
    host: 'codex-cli', requireFile: 'version-check.js', notFoundMessage: 'missing fixture',
    trailingCommand: ['printf', String.raw`'a\nb'`, String.raw`c\\d`, String.raw`e\'`, String.raw`f\ `],
  });
  expect(command.endsWith(String.raw`printf '\''a\nb'\'' c'\\'\d e'\\''\'' f\ '`)).toBe(true);
});

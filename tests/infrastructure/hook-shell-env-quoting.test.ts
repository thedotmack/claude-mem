import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildShellCommand } from '../../src/build/hook-shell-template.js';
import { checkWindowsGitBash } from '../../src/npx-cli/utils/windows-git-bash-preflight.js';

/**
 * The generated command is a shell command line, so an extraEnv value with a
 * space, quote, or metacharacter has to survive as one shell word. These tests
 * run the generated command instead of matching its text: the generator wraps
 * the whole body in `/bin/sh -c '…'` and escapes quotes at that layer, so a
 * raw-substring assertion would test the wrapper, not the value.
 */
const posixShell = process.platform === 'win32'
  ? checkWindowsGitBash().resolvedPath ?? null
  : '/bin/sh';

function shellCommand(extraEnv: Record<string, string>): string {
  return buildShellCommand({
    host: 'codex-cli',
    requireFile: 'bun-runner.js',
    requireFileSecondary: 'worker-service.cjs',
    trailingCommand: [
      'node',
      '"$_P/scripts/bun-runner.js"',
      '"$_P/scripts/worker-service.cjs"',
      'hook',
      'codex',
    ],
    notFoundMessage: 'missing',
    requireDependencies: true,
    extraEnv,
  });
}

function runWithValue(value: string): void {
  if (!posixShell) throw new Error('a POSIX shell is required for this test');
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-env-quote-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'scripts', 'worker-service.cjs'), '');
    writeFileSync(
      join(dir, 'scripts', 'bun-runner.js'),
      "process.stdout.write(JSON.stringify({ value: process.env.CLAUDE_MEM_TEST ?? null }) + '\\n');",
    );
    // Feed the command through a script file rather than `sh -c <argv>`: Git
    // Bash re-parses a Windows command line and collapses the `\\'` sequences
    // this command uses, so argv would test the Windows marshalling layer.
    writeFileSync(join(dir, 'run.sh'), shellCommand({ CLAUDE_MEM_TEST: value }));

    const result = spawnSync(posixShell, ['run.sh'], {
      cwd: dir,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: dir,
        CLAUDE_CONFIG_DIR: join(dir, 'config'),
        HOME: dir,
      },
      encoding: 'utf8',
      timeout: 20000,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`status ${result.status}: ${result.stderr}`);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).value).toBe(value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated shell commands keep safe extraEnv values bare', () => {
  test('leaves CLAUDE_MEM_CODEX_HOOK=1 unchanged', () => {
    expect(shellCommand({ CLAUDE_MEM_CODEX_HOOK: '1' })).toContain('CLAUDE_MEM_CODEX_HOOK=1 node');
  });
});

describe.skipIf(posixShell === null)('generated shell commands quote unsafe extraEnv values', () => {
  for (const value of ['two words', "it's", 'x; echo INJECTED', '$HOME']) {
    test(`keeps ${JSON.stringify(value)} as one value`, () => {
      runWithValue(value);
    });
  }
});

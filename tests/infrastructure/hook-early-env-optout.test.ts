import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { buildShellCommand, buildCodexWindowsCommand } from '../../src/build/hook-shell-template.js';

const flags = [
  'CLAUDE_MEM_DISABLE_TOOL_HOOKS',
  'CLAUDE_MEM_DISABLE_OBSERVATION',
  'CLAUDE_MEM_DISABLE_FILE_CONTEXT',
];

function probe(event: string, flag: string, windows = false, value?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-early-optout-'));
  const marker = join(dir, 'started');
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'worker-service.cjs'), '');
    writeFileSync(join(dir, 'scripts', 'bun-runner.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`);
    const args = ['hook', windows ? 'codex' : 'claude-code', event];
    const command = windows ? buildCodexWindowsCommand(args) : buildShellCommand({
      host: 'claude-code',
      requireFile: 'bun-runner.js',
      requireFileSecondary: 'worker-service.cjs',
      trailingCommand: ['node', '"$_P/scripts/bun-runner.js"', '"$_P/scripts/worker-service.cjs"', ...args],
      notFoundMessage: 'missing',
      failOpen: true,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: dir,
      CLAUDE_CONFIG_DIR: join(dir, 'config'),
      HOME: dir,
    };
    for (const name of flags) delete env[name];
    if (value !== undefined) env[flag] = value;
    const result = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    return { status: result.status, stderr: result.stderr, started: existsSync(marker) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const windows of [false, true]) {
  for (const [event, flag] of [
    ['file-context', 'CLAUDE_MEM_DISABLE_FILE_CONTEXT'],
    ['observation', 'CLAUDE_MEM_DISABLE_OBSERVATION'],
    ['file-context', 'CLAUDE_MEM_DISABLE_TOOL_HOOKS'],
    ['observation', 'CLAUDE_MEM_DISABLE_TOOL_HOOKS'],
  ]) {
    for (const value of ['1', '0', 'true', '', undefined]) {
      test(`launcher ${event} ${flag}=${value ?? '<unset>'} windows=${windows}`, () => {
        expect(probe(event, flag, windows, value)).toEqual({
          status: 0,
          stderr: '',
          started: value !== '1',
        });
      });
    }
  }
}
test('does not skip an unrelated tool hook', () => {
  expect(probe('observation', 'CLAUDE_MEM_DISABLE_FILE_CONTEXT', false, '1').started).toBe(true);
});
test('does not skip SessionStart context', () => {
  expect(probe('context', 'CLAUDE_MEM_DISABLE_TOOL_HOOKS', false, '1').started).toBe(true);
});

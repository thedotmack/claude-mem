import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFilePaths } from '../../../src/cli/adapters/codex-file-context.js';

function fixture(run: (cwd: string, home: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'shell-tilde-context-'));
  const cwd = join(root, 'checkout'), home = join(root, 'home');
  mkdirSync(join(cwd, '~'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(cwd, '~', 'notes.txt'), 'literal tilde file');
  writeFileSync(join(home, 'notes.txt'), 'different home file');
  try { run(cwd, home); } finally { rmSync(root, { recursive: true, force: true }); }
}

// PowerShell (Codex's Windows shell) resolves a quoted '~/x' to home, so the
// literal-tilde rule is POSIX-only; the win32 behavior is pinned further down.
const posixOnly = { skip: process.platform === 'win32' };

for (const command of ['cat "~/notes.txt"', "cat '~/notes.txt'", 'cat \\~/notes.txt', "cat ''~/notes.txt"]) {
  test(`file context respects literal tilde in ${command}`, posixOnly, () => fixture((cwd, home) => {
    // On POSIX, prove the actual reader selects cwd/~/notes.txt, not the
    // unrelated home file. The extraction assertions are platform-neutral.
    if (process.platform !== 'win32') {
      assert.equal(execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8' }), 'literal tilde file');
    }
    assert.deepEqual(extractFilePaths('Bash', { command }, cwd, home), ['~/notes.txt']);
  }));
}

test('an argv array never receives implicit shell tilde expansion', posixOnly, () => fixture((cwd, home) => {
  if (process.platform !== 'win32') {
    assert.equal(execFileSync('cat', ['~/notes.txt'], { cwd, encoding: 'utf8' }), 'literal tilde file');
  }
  assert.deepEqual(extractFilePaths('Bash', { command: ['cat', '~/notes.txt'] }, cwd, home), ['~/notes.txt']);
}));

test('unquoted shell tilde still expands, including a quoted suffix', () => fixture((cwd, home) => {
  assert.deepEqual(extractFilePaths('Bash', { command: 'cat ~/notes.txt' }, cwd, home), [join(home, 'notes.txt')]);
  assert.deepEqual(extractFilePaths('Bash', { command: "cat ~/\"notes.txt\"" }, cwd, home), [join(home, 'notes.txt')]);
}));

test('an expanded home path has the same shape as path.join, even for a trailing-slash home', posixOnly, () => fixture((cwd, home) => {
  assert.deepEqual(extractFilePaths('Bash', { command: 'cat ~/notes.txt' }, cwd, `${home}/`), [join(home, 'notes.txt')]);
}));

test('on Windows a quoted tilde still names the home directory, as PowerShell resolves it', { skip: process.platform !== 'win32' }, () => fixture((cwd, home) => {
  for (const command of ['cat ~/notes.txt', 'cat "~/notes.txt"', "cat '~/notes.txt'"]) {
    assert.deepEqual(extractFilePaths('Bash', { command }, cwd, home), [join(home, 'notes.txt')]);
  }
}));

test('unquoted tilde expansion sees through a shell line continuation', posixOnly, () => fixture((cwd, home) => {
  assert.deepEqual(extractFilePaths('Bash', { command: 'cat \\\n~/notes.txt' }, cwd, home), [join(home, 'notes.txt')]);
  for (const continuation of ['\\\n', '\\\n\\\n']) {
    const command = `cat ~${continuation}/notes.txt`;
    if (process.platform !== 'win32') {
      assert.equal(execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } }), 'different home file');
    }
    assert.deepEqual(extractFilePaths('Bash', { command }, cwd, home), [join(home, 'notes.txt')]);
  }
}));

test('single quotes preserve a literal backslash and newline', { skip: process.platform === 'win32' }, () => fixture((cwd, home) => {
  const operand = '~\\\n/notes.txt';
  mkdirSync(join(cwd, '~\\\n'));
  writeFileSync(join(cwd, operand), 'literal backslash and newline');
  const command = `cat '${operand}'`;
  assert.equal(execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } }), 'literal backslash and newline');
  assert.deepEqual(extractFilePaths('Bash', { command }, cwd, home), [operand]);
}));

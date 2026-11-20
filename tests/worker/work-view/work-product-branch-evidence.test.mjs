import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'branch-product-'));
  directories.push(cwd);
  const run = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  const git = (...args) => {
    const result = run(...args);
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
    return result;
  };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Branch product regression');
  git('config', 'user.email', 'branch-product@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'file.txt'), 'original\n');
  git('add', 'file.txt');
  git('commit', '-m', 'Initial content');
  return { cwd, git, run };
}

const branches = (command, result) => productsFromToolUse({ id: 1, tool_name: 'Bash',
  tool_input: JSON.stringify({ command }), tool_response: JSON.stringify({ stdout: result.stdout, stderr: result.stderr }) })
  .filter(product => product.kind === 'branch').map(product => product.branch);

test('an untaken shell branch and a quiet invocation are not evidence of creating a branch', () => {
  expect(branches('false && git switch -c never-created', { stdout: '', stderr: '' })).toEqual([]);
  expect(branches('git checkout -q -b unconfirmed', { stdout: '', stderr: '' })).toEqual([]);
});

test('a checkout refused because it would overwrite local work creates no branch product', () => {
  const { cwd, git, run } = repository();
  git('switch', '-c', 'other');
  writeFileSync(join(cwd, 'file.txt'), 'other branch\n');
  git('commit', '-am', 'Change content');
  git('switch', 'main');
  writeFileSync(join(cwd, 'file.txt'), 'uncommitted work\n');
  const refused = run('switch', '-c', 'blocked', 'other');
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('error:');
  expect(run('show-ref', '--verify', 'refs/heads/blocked').status).not.toBe(0);
  expect(branches('git switch -c blocked other', refused)).toEqual([]);
});

test('a later fatal command does not erase a branch that Git already confirmed', () => {
  const { git, run } = repository();
  const created = git('switch', '-c', 'created');
  const refused = run('switch', '-c', 'created');
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('fatal:');
  expect(branches('git switch -c created && git switch -c created', {
    stdout: created.stdout + refused.stdout, stderr: created.stderr + refused.stderr,
  })).toEqual(['created']);
});

test('confirmed creation and reset outputs retain only the branch Git names', () => {
  const { git } = repository();
  expect(branches('git checkout -b feature', git('checkout', '-b', 'feature'))).toEqual(['feature']);
  git('switch', 'main');
  expect(branches('git switch -C feature', git('switch', '-C', 'feature'))).toEqual(['feature']);
  expect(branches('git checkout -B feature', git('checkout', '-B', 'feature'))).toEqual(['feature']);
  expect(branches('git switch -c not-run', { stdout: '', stderr: "Switched to a new branch 'another'\n" })).toEqual([]);
});

test('localized Git output still credits the branch it names', () => {
  expect(branches('git switch -c feature', { stdout: '', stderr: "Zu neuem Branch 'feature' gewechselt\n" })).toEqual(['feature']);
  expect(branches('git checkout -b feature', { stdout: '', stderr: "切换到一个新分支 'feature'\n" })).toEqual(['feature']);
});

test('an unrelated failure before an untaken branch creation credits nothing', () => {
  const npmFailure = 'npm error code ELIFECYCLE\nnpm error command failed\nnpm error command sh -c bun test\n';
  expect(branches('npm test && git switch -c x', { stdout: '', stderr: npmFailure })).toEqual([]);
});

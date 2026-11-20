import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const remoteUrl = 'https://github.com/example/push-options.git';
const cases = [
  ['separate push option', ['-q', '-o', 'ci.skip']],
  ['long push option', ['-q', '--push-option', 'ci.skip']],
  ['quoted push option', ['-q', '-o', 'merge_request.label=ready for review']],
  ['inline long value', ['-q', '--push-option=ci.skip']],
  ['receive-pack program', ['-q', '--receive-pack', 'git-receive-pack']],
  ['exec program', ['-q', '--exec', 'git-receive-pack']],
  ['submodule mode', ['-q', '--recurse-submodules', 'no']],
  ['overridden repo option', ['-q', '--repo', 'unused-repository']],
  ['overridden inline repo option', ['-q', '--repo=unused-repository']],
  ['dry-run text as a value', ['-q', '-o', '--dry-run']],
  ['delete text as a value', ['-q', '-o', '--delete']],
  ['attached short value', ['-qodone']],
  ['actual dry run', ['-qn', '-o', 'ci.skip'], 'dry-run'],
  ['option terminator', ['-q', '--']],
  ['combined deletion flags', ['-qd'], 'delete'],
  ['explicit tag shorthand', ['-q'], 'tag'],
  ['tag shorthand after a valued option', ['-q', '-o', 'ci.skip'], 'tag'],
  ['branch named tag', ['-q'], 'branch-tag'],
  ['branch and tag shorthand', ['-q'], 'mixed-tag'],
  ['tag shorthand before a branch', ['-q'], 'mixed-tag-first'],
  ['all tags with an explicit branch', ['-q', '--tags'], 'mixed-all-tags'],
];

for (const [name, options, operation = 'push'] of cases) {
  test(`quiet push products respect ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-options-product-'));
    const cwd = join(dir, 'source'), remote = join(dir, 'remote.git');
    mkdirSync(cwd);
    const run = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const git = (...args) => {
      const result = run(...args);
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
      return result;
    };
    try {
      git('init', '-q', '--initial-branch=main');
      git('config', 'user.name', 'Push product regression');
      git('config', 'user.email', 'push-product@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('commit', '-q', '--allow-empty', '-m', 'Recorded work');
      git('init', '-q', '--bare', remote);
      git('--git-dir=' + remote, 'config', 'receive.advertisePushOptions', 'true');
      // Git performs the push solely against this local bare repository.
      // Keep the public URL in the recorded command to verify the product link.
      git('config', `url.${remote}.insteadOf`, remoteUrl);
      if (operation === 'delete') git('push', '-q', remoteUrl, 'HEAD:review/topic');
      const mixed = operation.startsWith('mixed-');
      if (operation === 'tag' || mixed) git('tag', 'v1');
      const branch = mixed ? 'main' : operation === 'branch-tag' ? 'tag' : 'review/topic';
      const pushingBranch = operation === 'push' || operation === 'branch-tag' || mixed;
      const refspecs = operation === 'tag' ? ['tag', 'v1']
        : operation === 'mixed-tag' ? ['main', 'tag', 'v1']
          : operation === 'mixed-tag-first' ? ['tag', 'v1', 'main']
            : [operation === 'delete' ? branch : 'HEAD:' + branch];
      const args = ['push', ...options, remoteUrl, ...refspecs];
      const result = git(...args);
      expect(result.stdout + result.stderr).toBe('');
      const ref = run('--git-dir=' + remote, 'rev-parse', '--verify', 'refs/heads/' + branch);
      if (pushingBranch) expect(ref.stdout).toBe(git('rev-parse', 'HEAD').stdout);
      else expect(ref.status).not.toBe(0);
      if (operation === 'tag') expect(git('--git-dir=' + remote, 'show-ref').stdout.trim())
        .toBe(git('rev-parse', 'HEAD').stdout.trim() + ' refs/tags/v1');
      if (mixed) expect(git('--git-dir=' + remote, 'rev-parse', '--verify', 'refs/tags/v1').stdout)
        .toBe(git('rev-parse', 'HEAD').stdout);

      const command = 'git ' + args.map(arg => /\s/.test(arg) ? `'${arg}'` : arg).join(' ');
      const products = productsFromToolUse({ id: 1, tool_name: 'Bash',
        tool_input: JSON.stringify({ command }),
        tool_response: JSON.stringify({ stdout: result.stdout, stderr: result.stderr }) });
      expect(products.map(({ branch, repo, url }) => ({ branch, repo, url }))).toEqual(pushingBranch
        ? [{ branch, repo: 'example/push-options', url: 'https://github.com/example/push-options/tree/' + branch }]
        : []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const inline of [false, true]) {
  test(`a ${inline ? 'inline' : 'separate'} --repo supplies the link for a confirmed default push`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-default-product-'));
    const cwd = join(dir, 'source'), remote = join(dir, 'remote.git');
    mkdirSync(cwd);
    const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
      return result;
    };
    try {
      git('init', '-q', '--initial-branch=main');
      git('config', 'user.name', 'Push product regression');
      git('config', 'user.email', 'push-product@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'push.default', 'current');
      git('commit', '-q', '--allow-empty', '-m', 'Recorded work');
      git('init', '-q', '--bare', remote);
      git('config', `url.${remote}.insteadOf`, remoteUrl);
      const command = `git push --repo${inline ? '=' : ' '}${remoteUrl} 2>&1 | tail -1`;
      const result = spawnSync('bash', ['-o', 'pipefail', '-c', command], { cwd, env, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\[new branch\]\s+main -> main/);
      expect(result.stdout).not.toContain('To ');
      expect(git('--git-dir=' + remote, 'rev-parse', '--verify', 'refs/heads/main').stdout)
        .toBe(git('rev-parse', 'HEAD').stdout);
      const products = productsFromToolUse({ id: 1, tool_name: 'Bash',
        tool_input: JSON.stringify({ command }),
        tool_response: JSON.stringify({ stdout: result.stdout, stderr: result.stderr }) });
      expect(products.map(({ branch, repo, url }) => ({ branch, repo, url })))
        .toEqual([{ branch: 'main', repo: 'example/push-options', url: 'https://github.com/example/push-options/tree/main' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const redirectedCases = [
  ['dry run after a file redirection', `git push ${remoteUrl} main >push.log --dry-run`, 'dry-run'],
  ['quiet dry run after a file redirection', `git push -q ${remoteUrl} main >push.log --dry-run`, 'dry-run'],
  ['dry run after an fd redirection', `git push ${remoteUrl} main 2>&1 --dry-run | tail -1`, 'dry-run'],
  ['dry run after an input redirection', `git push -q ${remoteUrl} main <input.txt --dry-run`, 'dry-run'],
  ['deletion after a redirection', `git push -q ${remoteUrl} main 2>errors.log --delete`, 'delete'],
  ['push option after a redirection', `git push -q ${remoteUrl} main >push.log --push-option=ci.skip`, 'push'],
  ['flag-like output filename', `git push -q ${remoteUrl} main >--dry-run`, 'push'],
  ['quoted output filename', `git push -q ${remoteUrl} main >'push --dry-run.log'`, 'push'],
  ['flag text in a here-string', `git push -q ${remoteUrl} main <<<"--dry-run"`, 'push'],
  ['delete text in an fd here-string', `git push -q ${remoteUrl} main 0<<<"--delete"`, 'push'],
  ['real dry run after a here-string', `git push -q ${remoteUrl} main <<<"input only" --dry-run`, 'dry-run'],
  ['dry-run text in a shell comment', `git push -q ${remoteUrl} main >push.log # --dry-run`, 'push'],
  ['delete text in a shell comment', `git push -q ${remoteUrl} main # --delete`, 'push'],
  ['another command inside a shell comment', `git push -q ${remoteUrl} main # later; git push --dry-run ${remoteUrl} main`, 'push'],
  ['quoted hash in a push option', `git push -q -o '# --dry-run' ${remoteUrl} main`, 'push'],
  ['embedded hash in a push option', `git push -q --push-option=label#--dry-run ${remoteUrl} main`, 'push'],
  ['embedded hash in a redirected filename', `git push -q ${remoteUrl} main >push#--dry-run.log`, 'push'],
];

for (const [name, command, operation] of redirectedCases) {
  test(`push products respect ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-redirection-product-'));
    const cwd = join(dir, 'source'), remote = join(dir, 'remote.git');
    mkdirSync(cwd);
    const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    const run = (...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    const git = (...args) => {
      const result = run(...args);
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
      return result;
    };
    try {
      git('init', '-q', '--initial-branch=main');
      git('config', 'user.name', 'Push product regression');
      git('config', 'user.email', 'push-product@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('commit', '-q', '--allow-empty', '-m', 'Recorded work');
      // Name the bare remote's HEAD something other than main: when a machine's git config sets
      // init.defaultBranch=main (Xcode's git does), receive.denyDeleteCurrent refuses the delete case.
      git('init', '-q', '--bare', '--initial-branch=trunk', remote);
      git('--git-dir=' + remote, 'config', 'receive.advertisePushOptions', 'true');
      git('config', `url.${remote}.insteadOf`, remoteUrl);
      writeFileSync(join(cwd, 'input.txt'), '');
      if (operation === 'delete') git('push', '-q', remoteUrl, 'main');
      const result = spawnSync('bash', ['-o', 'pipefail', '-c', command], { cwd, env, encoding: 'utf8' });
      expect(result.status).toBe(0);
      const ref = run('--git-dir=' + remote, 'rev-parse', '--verify', 'refs/heads/main');
      if (operation === 'push') expect(ref.stdout).toBe(git('rev-parse', 'HEAD').stdout);
      else expect(ref.status).not.toBe(0);
      const products = productsFromToolUse({ id: 1, tool_name: 'Bash',
        tool_input: JSON.stringify({ command }),
        tool_response: JSON.stringify({ stdout: result.stdout, stderr: result.stderr }) });
      expect(products.map(({ branch, repo, url }) => ({ branch, repo, url }))).toEqual(operation === 'push'
        ? [{ branch: 'main', repo: 'example/push-options', url: 'https://github.com/example/push-options/tree/main' }]
        : []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

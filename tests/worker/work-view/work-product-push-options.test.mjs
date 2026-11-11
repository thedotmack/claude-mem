import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
      const args = ['push', ...options, remoteUrl, operation === 'delete' ? 'review/topic' : 'HEAD:review/topic'];
      const result = git(...args);
      expect(result.stdout + result.stderr).toBe('');
      const ref = run('--git-dir=' + remote, 'rev-parse', '--verify', 'refs/heads/review/topic');
      if (operation === 'push') expect(ref.stdout).toBe(git('rev-parse', 'HEAD').stdout);
      else expect(ref.status).not.toBe(0);

      const command = 'git ' + args.map(arg => /\s/.test(arg) ? `'${arg}'` : arg).join(' ');
      const products = productsFromToolUse({ id: 1, tool_name: 'Bash',
        tool_input: JSON.stringify({ command }),
        tool_response: JSON.stringify({ stdout: result.stdout, stderr: result.stderr }) });
      expect(products.map(({ branch, repo, url }) => ({ branch, repo, url }))).toEqual(operation === 'push'
        ? [{ branch: 'review/topic', repo: 'example/push-options', url: 'https://github.com/example/push-options/tree/review/topic' }]
        : []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

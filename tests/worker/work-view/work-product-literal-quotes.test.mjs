import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitProductsFromCommand } from '../../../src/services/work-view/work-product.mjs';

const tick = String.fromCharCode(96);
const cases = [
  ['single-quoted dollar', "'fix: keep \\$HOME literal'", 'fix: keep \\$HOME literal'],
  ['single-quoted double quote', "'fix: keep \\\"name\\\" literal'", 'fix: keep \\"name\\" literal'],
  ['single-quoted backticks', "'fix: keep \\" + tick + "value\\" + tick + " literal'", 'fix: keep \\' + tick + 'value\\' + tick + ' literal'],
  ['single-quoted backslashes', "'fix: keep \\\\server literal'", 'fix: keep \\\\server literal'],
  ['double-quoted dollar', '"fix: keep \\$HOME literal"', 'fix: keep $HOME literal'],
  ['double-quoted escaped quotes', '"fix: keep \\"name\\" literal"', 'fix: keep "name" literal'],
  ['single-quoted ordinary text', "'fix: keep ordinary text'", 'fix: keep ordinary text'],
  ['double-quoted ordinary backslash', '"fix: keep \\path literal"', 'fix: keep \\path literal'],
];

for (const [name, argument, expected] of cases) {
  test(name + ' matches the subject from a real quiet Git commit', { skip: process.platform === 'win32' }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cmem-commit-quotes-'));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Commit quote fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'commit.gpgSign', 'false');
      git('config', 'core.hooksPath', join(cwd, 'no-hooks'));
      const command = 'git commit --allow-empty -q -m ' + argument + ' && git log --oneline --abbrev=40 -1';
      const out = execFileSync('bash', ['-c', command], { cwd, env, encoding: 'utf8' });
      const sha = git('rev-parse', 'HEAD');
      assert.equal(git('log', '-1', '--format=%s'), expected);

      const products = gitProductsFromCommand(command, {}, out);
      assert.equal(products.length, 1);
      assert.equal(products[0].kind, 'commit');
      assert.equal(products[0].sha, sha);
      assert.equal(products[0].title, sha.slice(0, 7) + ' ' + expected);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

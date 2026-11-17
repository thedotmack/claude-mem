import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitProductsFromCommand } from '../../../src/services/work-view/work-product.mjs';

const cases = [
  ['long separate single quotes', "--message 'fix: preserve long message'", 'fix: preserve long message'],
  ['long equals single quotes', "--message='fix: preserve equals message'", 'fix: preserve equals message'],
  ['long separate double quotes', '--message "fix: preserve long double quotes"', 'fix: preserve long double quotes'],
  ['long equals double quotes', '--message="fix: preserve equals double quotes"', 'fix: preserve equals double quotes'],
  ['long literal backslash', "--message='fix: retain \\$HOME literally'", 'fix: retain \\$HOME literally'],
  ['long separate heredoc', '--message "$(cat <<\'EOF\'\nfix: retain "quoted" heredoc\nEOF\n)"', 'fix: retain "quoted" heredoc'],
  ['long equals heredoc', '--message="$(cat <<\'EOF\'\nfix: retain equals heredoc\nEOF\n)"', 'fix: retain equals heredoc'],
  ['short option control', "-m 'fix: preserve short message'", 'fix: preserve short message'],
  ['clustered option control', "-qm 'fix: preserve clustered message'", 'fix: preserve clustered message'],
  ['long literal shell separators', "--message='fix: preserve ; and && and |'", 'fix: preserve ; and && and |'],
  ['duplicated output descriptor', "2>&1 -m 'fix: descriptor redirection'", 'fix: descriptor redirection'],
  ['duplicated input descriptor', "3<&0 --message='fix: input descriptor'", 'fix: input descriptor'],
  ['combined output redirection', "&>/dev/null --message 'fix: combined redirect'", 'fix: combined redirect'],
  ['combined append redirection', "&>>message-output.log --message 'fix: append redirect'", 'fix: append redirect'],
  ['clobber output redirection', ">|/dev/null --message 'fix: clobber redirect'", 'fix: clobber redirect'],
  ['heredoc before long tag message', "-F - <<'EOF'\nfix: commit before release tag\nEOF", 'fix: commit before release tag', "\ngit tag -a v1 --message 'Release tag'\n"],
  ['heredoc before substituted tag message', "-F - <<'EOF'\nfix: commit before substituted tag\nEOF", 'fix: commit before substituted tag', '\ngit tag -a v1 --message="$(cat <<\'TAG\'\nRelease tag\nTAG\n)"\n'],
];

for (const [name, argument, subject, followup = ' && '] of cases) {
  test(name + ' retains a quiet commit in My Work', { skip: process.platform === 'win32' }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cmem-message-options-'));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Message option fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'commit.gpgSign', 'false');
      git('config', 'core.hooksPath', join(cwd, 'no-hooks'));
      const command = `git commit --allow-empty -q ${argument}${followup}git log --oneline --abbrev=40 -1`;
      const output = execFileSync('bash', ['-c', command], { cwd, env, encoding: 'utf8' });
      const sha = git('rev-parse', 'HEAD');
      assert.equal(git('log', '-1', '--format=%s'), subject);
      const products = gitProductsFromCommand(command, {}, output);
      assert.equal(products.length, 1);
      assert.equal(products[0].sha, sha);
      assert.equal(products[0].title, `${sha.slice(0, 7)} ${subject}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

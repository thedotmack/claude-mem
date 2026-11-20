// Real Git writes each push result below. The SSH command is a local receive-pack fixture:
// no network, GitHub credentials, global Git config or external repository are used.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { githubRepo, productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const remoteUrls = [
  'git@github.com:fixture-owner/fixture-repo.git',
  'ssh://git@github.com/fixture-owner/fixture-repo.git',
  'ssh://git@github.com:22/fixture-owner/fixture-repo.git',
  'ssh://git@ssh.github.com:443/fixture-owner/fixture-repo.git',
];

for (const remoteUrl of remoteUrls) {
  test('links the commit and branch from native push output for ' + remoteUrl, () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-product-ssh-'));
    const work = join(directory, 'work'), remote = join(directory, 'remote.git');
    const config = join(directory, 'gitconfig'), shim = join(directory, 'ssh.mjs');
    writeFileSync(config, '');
    writeFileSync(shim, [
      "import { spawnSync } from 'node:child_process';",
      "const result = spawnSync('git', ['receive-pack', process.env.TEST_GIT_REMOTE], { stdio: 'inherit' });",
      'process.exit(result.status ?? 1);',
    ].join('\n'));
    // Git interprets GIT_SSH_COMMAND with its shell, also on Git for Windows.
    const quotePath = value => "'" + (process.platform === 'win32' ? value.replaceAll('\\', '/') : value)
      .replaceAll("'", "'\\''") + "'";
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', LANG: 'C',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_SSH_VARIANT: 'ssh', GIT_SSH_COMMAND: quotePath(process.execPath) + ' ' + quotePath(shim),
      TEST_GIT_REMOTE: remote,
    };
    const git = args => {
      const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result;
    };
    try {
      git(['init', '--bare', remote]);
      git(['init', '-b', 'main', work]);
      git(['-C', work, 'remote', 'add', 'origin', remoteUrl]);
      writeFileSync(join(work, 'record.txt'), 'SSH transport evidence\n');
      git(['-C', work, 'add', 'record.txt']);
      const commit = git(['-C', work, 'commit', '-m', 'Record SSH transport evidence']);
      const pushed = git(['-C', work, 'push', 'origin', 'main']);
      const sha = git(['-C', work, 'rev-parse', 'HEAD']).stdout.trim();
      assert.equal(git(['--git-dir=' + remote, 'rev-parse', 'main']).stdout.trim(), sha);

      const products = productsFromToolUse({
        id: 1, tool_name: 'Bash',
        tool_input: JSON.stringify({ command: 'git commit -m "Record SSH transport evidence" && git push origin main' }),
        tool_response: JSON.stringify({ stdout: commit.stdout + pushed.stdout, stderr: commit.stderr + pushed.stderr }),
      });
      const recordedCommit = products.find(product => product.kind === 'commit');
      const recordedBranch = products.find(product => product.kind === 'branch');
      assert.equal(recordedCommit?.repo, 'fixture-owner/fixture-repo');
      assert.ok(sha.startsWith(recordedCommit.sha));
      assert.equal(recordedCommit.url, 'https://github.com/fixture-owner/fixture-repo/commit/' + recordedCommit.sha);
      assert.equal(recordedBranch?.url, 'https://github.com/fixture-owner/fixture-repo/tree/main');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('recognizes configured and anonymized GitHub SSH spellings', () => {
  for (const url of remoteUrls) {
    assert.equal(githubRepo(url), 'fixture-owner/fixture-repo');
    assert.equal(githubRepo(url.replace('git@', '')), 'fixture-owner/fixture-repo');
  }
  assert.equal(githubRepo('https://github.com/fixture-owner/fixture-repo.git'), 'fixture-owner/fixture-repo');
});

test('leaves non-GitHub hosts, unrelated ports and local remotes unlinked', () => {
  for (const url of [
    'git@gitlab.com:fixture-owner/fixture-repo.git',
    'github.com.example:fixture-owner/fixture-repo.git',
    'ssh://git@github.com.example/fixture-owner/fixture-repo.git',
    'ssh://git@ssh.github.com:444/fixture-owner/fixture-repo.git',
    'ssh://git@github.com:2222/fixture-owner/fixture-repo.git',
    'file:///tmp/fixture-repo.git',
    'origin',
  ]) assert.equal(githubRepo(url), null);
});

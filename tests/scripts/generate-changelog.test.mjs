import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/generate-changelog.js', import.meta.url));

test('renders published releases without treating tag or body text as commands or boilerplate', {
  skip: process.platform === 'win32', // POSIX fixture executable
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const releases = [
    { tagName: 'v2.0', publishedAt: '2026-02-01', body: '# v2.0\r\n\r\nKeep this.\n## 3 changes\nDetails\n---\n\n🤖 Generated with [Claude Code](https://example.org)' },
    { tagName: 'v1.0;false', publishedAt: '2026-01-01', body: '🤖 Generated with [Claude Code](https://example.org)\nAn example above.\n## 2 fixes\nKeep trailing hyphens---' },
    { tagName: 'v0.1', publishedAt: '2025-01-01', body: null },
  ];
  const stub = `#!/usr/bin/env node
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args[0], 'api');
assert.ok(args.includes('--paginate'));
assert.match(args[args.indexOf('--jq')+1], /select\\(\\.draft \\| not\\)/);
for (const release of JSON.parse(process.env.GH_FIXTURE)) console.log(JSON.stringify(release));
process.exitCode = Number(process.env.GH_EXIT || 0);
`;
  writeFileSync(join(dir, 'gh'), stub, { mode: 0o755 });
  const run = (extra = {}) => spawnSync(process.execPath, [script], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: dir + delimiter + process.env.PATH,
      GH_FIXTURE: JSON.stringify(releases), ...extra },
  });
  const target = join(dir, 'docs/CHANGELOG.md');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const value = readFileSync(target, 'utf8');
  assert.match(value, /Keep this\.\n## 3 changes\nDetails/);
  assert.doesNotMatch(value, /# v2\.0|Details\n---/);
  assert.match(value, /## \[1\.0;false\].*\n\n🤖 Generated with[^\n]*\nAn example above\.\n## 2 fixes\nKeep trailing hyphens---/);
  assert.match(value, /## \[0\.1\]/);
  assert.equal(run({ GH_EXIT: '1' }).status, 1);
  assert.equal(readFileSync(target, 'utf8'), value);
});

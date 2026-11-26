import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; steps: Step[]; permissions?: Record<string, string> };
const workflow = Bun.YAML.parse(readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8')) as {
  on: Record<string, unknown>; jobs: Record<string, Job>;
};
const attach = workflow.jobs['attach-messages'];
const attachment = attach.steps.find(step => step.name?.startsWith('Attach the Mac app'))!.run!;
const notesCommand = workflow.jobs['release-notes'].steps.find(step => step.name?.startsWith('Prepare notes'))!.run!;
const scriptPath = new URL('../../scripts/github-tagged-release.mjs', import.meta.url).pathname;
const sha = 'a'.repeat(40);
const appName = 'Claude-Mem-Messages.zip';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Exercise the workflow's actual bash and digest checks. The fixtures implement
// only the GitHub operations and public download used by this job.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const { GITHUB_SHA: sha, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repo } = process.env;
const [command, operation] = args;
function write(kind) { fs.appendFileSync('writes', kind + '\\n'); }
if (command === 'api') {
  if (operation === 'repos/' + repo + '/git/ref/tags/' + tag) {
    const type = fs.existsSync('annotated') ? 'tag' : 'commit';
    console.log(JSON.stringify({ object: { type, sha: type === 'tag' ? 'b'.repeat(40) : fs.readFileSync('tag', 'utf8') } }));
  } else if (operation.endsWith('/git/tags/' + 'b'.repeat(40))) {
    console.log(JSON.stringify({ object: { type: 'commit', sha: fs.readFileSync('tag', 'utf8') } }));
  } else if (operation === 'repos/' + repo + '/releases/tags/' + tag) {
    if (!fs.existsSync('release')) process.exit(1);
    if (fs.existsSync('asset')) console.log(fs.readFileSync('asset', 'utf8'));
  } else throw new Error('Unexpected GitHub request ' + operation);
} else if (command === 'release' && operation === 'view') {
  if (!fs.existsSync('release')) process.exit(1);
  console.log(args.includes('isDraft') ? String(fs.existsSync('draft')) : JSON.stringify({ tagName: tag }));
} else if (command === 'release' && operation === 'create') {
  if (!args.includes('--verify-tag') || fs.existsSync('release')) process.exit(1);
  if (fs.existsSync('concurrent-release')) {
    fs.copyFileSync('concurrent-release', 'release');
    process.exit(1);
  }
  fs.copyFileSync(args[args.indexOf('--notes-file') + 1], 'release');
  write(args.includes('--prerelease') ? 'create-prerelease' : 'create-release');
} else if (command === 'release' && operation === 'upload') {
  if (args.includes('--clobber') || fs.existsSync('asset') || !fs.existsSync('release')) process.exit(1);
  const [file, label] = args[3].split('#');
  fs.copyFileSync(file, 'public.zip');
  const digest = 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync('asset', JSON.stringify({ label, state: 'uploaded', digest }));
  write('upload');
} else throw new Error('Unexpected command ' + args.join(' '));
`;
const fakeCurl = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const expected = 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/releases/download/' + process.env.GITHUB_REF_NAME + '/Claude-Mem-Messages.zip';
if (args.at(-1) !== expected) process.exit(1);
fs.copyFileSync('public.zip', args[args.indexOf('--output') + 1]);
`;

function fixture(tag = 'v17.0.0') {
  const root = mkdtempSync(join(tmpdir(), 'cmem-release-'));
  roots.push(root);
  for (const folder of ['release-artifacts', 'release-notes', 'scripts', 'docs']) mkdirSync(join(root, folder));
  const write = (path: string, content: string) => writeFileSync(join(root, path), content);
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  writeFileSync(join(root, 'gh'), fakeGh, { mode: 0o755 });
  writeFileSync(join(root, 'curl'), fakeCurl, { mode: 0o755 });
  write('tag', sha);
  write('writes', '');
  write('release-artifacts/' + appName, 'first verified archive');
  write('scripts/github-tagged-release.mjs', readFileSync(scriptPath, 'utf8'));
  write('package.json', JSON.stringify({ name: 'claude-mem', version: tag.slice(1) }));
  const notes = '### Messages for Mac\n\nDownload the app.\n';
  write('docs/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n' + notes + '\n## [16.2.1]\nEarlier release.');
  const env = {
    ...process.env, PATH: root + ':' + process.env.PATH, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, 'summary'),
    GITHUB_SHA: sha, GITHUB_REF_NAME: tag, GITHUB_REF_TYPE: 'tag', GITHUB_REPOSITORY: 'thedotmack/claude-mem',
  };
  const run = (script: string) => spawnSync('bash', ['-ec', script], { cwd: root, env, encoding: 'utf8' });
  const prepare = () => {
    const result = run(notesCommand);
    if (result.status === 0) write('release-notes/tagged-release-notes.md', read('tagged-release-notes.md'));
    return result;
  };
  return { root, write, read, run, prepare, notes };
}

test('both publication triggers require the publicly verified Mac asset and an isolated write job', () => {
  expect(workflow.on).toHaveProperty('push');
  expect(workflow.on).toHaveProperty('workflow_dispatch');
  expect(workflow.jobs.publish.needs).toBe('attach-messages');
  expect(attach.needs).toEqual(['messages', 'release-notes']);
  expect(attach.permissions).toEqual({ contents: 'write' });
  expect(attach.steps.filter(step => step.uses).map(step => step.uses)).toEqual([
    'actions/download-artifact@v4', 'actions/download-artifact@v4',
  ]);
  expect(workflow.jobs['release-notes'].permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs['release-notes'].steps[0].with?.ref).toBe('${{ github.sha }}');
  expect(workflow.jobs['release-notes'].steps.find(step => step.uses === 'actions/upload-artifact@v4')?.with?.overwrite).toBe(true);
  const publishScript = workflow.jobs.publish.steps.find(step => step.name === 'Publish')!.run!;
  expect(publishScript).toContain('github-tagged-release.mjs publication-state');
  expect(publishScript).not.toContain('GITHUB_EVENT_NAME');
});

describe.skipIf(process.platform === 'win32' || !Bun.which('jq') || !Bun.which('bash'))('tagged Mac release shell', () => {
  test('a new direct tag creates its changelog release, uploads once, and preserves manual edits on retry', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    expect(f.read('release-notes/tagged-release-notes.md')).toBe(f.notes);
    expect(f.run(attachment).status).toBe(0);
    expect(f.read('release')).toBe(f.notes);
    expect(f.read('writes')).toBe('create-release\nupload\n');
    expect(f.read('summary')).toContain(appName + ' sha256:');
    f.write('annotated', '');
    f.write('release', 'Notes edited by a maintainer.');
    f.write('docs/CHANGELOG.md', '## [17.0.0]\nDated notes.');
    f.write('release-artifacts/' + appName, 'fresh build with new ZIP timestamps');
    expect(f.prepare().status).toBe(0);
    expect(f.run(attachment).status).toBe(0);
    expect(f.read('writes')).toBe('create-release\nupload\n');
    expect(f.read('release')).toBe('Notes edited by a maintainer.');
    expect(f.read('public.zip')).toBe('first verified archive');
    f.write('public.zip', 'truncated download');
    expect(f.run(attachment).status).not.toBe(0);
  });

  test('a release created by the maintainer while publishing keeps their notes', () => {
    const f = fixture();
    f.write('concurrent-release', 'Maintainer title and notes');
    expect(f.prepare().status).toBe(0);
    expect(f.run(attachment).status).toBe(0);
    expect(f.read('release')).toBe('Maintainer title and notes');
    expect(f.read('writes')).toBe('upload\n');
  });

  test('a moved tag, missing notes, draft release, or differently attributed asset blocks publication', () => {
    const f = fixture();
    f.write('docs/CHANGELOG.md', '## [17.0.0]\nDated notes without a GitHub release.');
    expect(f.prepare().status).not.toBe(0);
    expect(f.run(attachment).status).not.toBe(0);
    f.write('release-notes/tagged-release-notes.md', f.notes);
    f.write('tag', 'c'.repeat(40));
    expect(f.run(attachment).status).not.toBe(0);
    expect(existsSync(join(f.root, 'release'))).toBe(false);
    f.write('tag', sha);
    f.write('release', 'Maintainer draft');
    f.write('draft', '');
    expect(f.run(attachment).status).not.toBe(0);
    rmSync(join(f.root, 'draft'));
    f.write('asset', JSON.stringify({ label: 'Different commit', state: 'uploaded', digest: 'sha256:' + 'c'.repeat(64) }));
    expect(f.run(attachment).status).not.toBe(0);
    expect(f.read('writes')).toBe('');
  });

  test('an annotated prerelease tag creates a GitHub prerelease', () => {
    const f = fixture('v17.1.0-beta.1');
    f.write('annotated', '');
    expect(f.prepare().status).toBe(0);
    expect(f.run(attachment).status).toBe(0);
    expect(f.read('writes')).toBe('create-prerelease\nupload\n');
  });
});

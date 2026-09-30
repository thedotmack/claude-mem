// #2737 — named environments: several directories that share one memory
// bucket. A matching environment names the project outright; the keys those
// directories were stored under before stay readable.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProjectContext, getProjectName } from '../../src/utils/project-name.js';

const ENVIRONMENTS_ENV = 'CLAUDE_MEM_PROJECT_ENVIRONMENTS';
const savedEnvironments = process.env[ENVIRONMENTS_ENV];

let tmp: string;
let repo: string;
let docs: string;
let outside: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-2737-')));
  repo = join(tmp, 'work', 'acme', 'api');
  docs = join(tmp, 'work', 'acme', 'docs');
  outside = join(tmp, 'play');
  for (const dir of [repo, docs, outside]) mkdirSync(dir, { recursive: true });

  const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  run('add', 'README.md');
  run('commit', '-q', '-m', 'base');

  process.env[ENVIRONMENTS_ENV] = JSON.stringify([{ name: 'acme', patterns: [`${tmp}/work/acme/**`] }]);
}, 30_000);

afterAll(() => {
  if (savedEnvironments === undefined) delete process.env[ENVIRONMENTS_ENV];
  else process.env[ENVIRONMENTS_ENV] = savedEnvironments;
  rmSync(tmp, { recursive: true, force: true });
});

describe('#2737 — named environments', () => {
  it('names every matching directory, git or not, after the environment', () => {
    expect(getProjectName(repo)).toBe('acme');
    expect(getProjectName(docs)).toBe('acme');
    expect(getProjectName(join(tmp, 'work', 'acme'))).toBe('acme');
    expect(getProjectName(outside)).toBe('play');
  });

  it('writes under the environment and keeps the derived key readable', () => {
    const ctx = getProjectContext(repo);
    expect(ctx.primary).toBe('acme');
    expect(ctx.parent).toBeNull();
    expect(ctx.allProjects).toEqual(['api', 'acme']);
  });

  it('falls back to the derived names when the setting is invalid', () => {
    process.env[ENVIRONMENTS_ENV] = '{not json';
    try {
      expect(getProjectName(repo)).toBe('api');
      expect(getProjectContext(docs).allProjects).toEqual(['docs']);
    } finally {
      process.env[ENVIRONMENTS_ENV] = JSON.stringify([{ name: 'acme', patterns: [`${tmp}/work/acme/**`] }]);
    }
  });

  // Resolving a project name runs inside every hook, so it must never write
  // files: with no settings.json yet, it reads the defaults instead of creating
  // one (and announcing that on stderr).
  it('never creates settings.json while resolving a project name', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-2737-settings-'));
    try {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir };
      delete env[ENVIRONMENTS_ENV];
      delete env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', `
          const { getProjectName, getProjectContext } = await import('./src/utils/project-name.ts');
          if (getProjectName(${JSON.stringify(outside)}) !== 'play') throw new Error('unexpected name');
          if (getProjectContext(${JSON.stringify(repo)}).primary !== 'api') throw new Error('unexpected context');
        `],
        cwd: process.cwd(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dataDir, 'settings.json'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('wins over a git-remote slug, keeping both derived keys readable', () => {
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'], { stdio: 'ignore' });
    const SOURCE_ENV = 'CLAUDE_MEM_PROJECT_NAME_SOURCE';
    const savedSource = process.env[SOURCE_ENV];
    process.env[SOURCE_ENV] = 'git-remote';
    try {
      const ctx = getProjectContext(repo);
      expect(ctx.primary).toBe('acme');
      expect(ctx.allProjects).toEqual(['api', 'acme/api', 'acme']);
    } finally {
      if (savedSource === undefined) delete process.env[SOURCE_ENV];
      else process.env[SOURCE_ENV] = savedSource;
    }
  });
});

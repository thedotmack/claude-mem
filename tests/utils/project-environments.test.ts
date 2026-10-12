import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { matchProjectEnvironment, parseProjectEnvironments } from '../../src/utils/project-environments.js';

describe('parseProjectEnvironments', () => {
  it('accepts the JSON-string form and a native array', () => {
    const environments = [{ name: 'work', patterns: ['~/work/acme/**'] }];
    expect(parseProjectEnvironments(JSON.stringify(environments))).toEqual(environments);
    expect(parseProjectEnvironments(environments)).toEqual(environments);
  });

  it('treats empty, invalid JSON and non-arrays as no environments', () => {
    expect(parseProjectEnvironments('')).toEqual([]);
    expect(parseProjectEnvironments('[]')).toEqual([]);
    expect(parseProjectEnvironments('{not json')).toEqual([]);
    expect(parseProjectEnvironments('{"name":"work"}')).toEqual([]);
    expect(parseProjectEnvironments(undefined)).toEqual([]);
  });

  it('skips entries without a name or patterns, keeping the valid ones', () => {
    expect(parseProjectEnvironments([
      { name: '', patterns: ['/a/**'] },
      { name: 'no-patterns', patterns: [] },
      { name: 'bad-patterns', patterns: [42, ' '] },
      { name: ' work ', patterns: ['/work/**', 7] },
    ])).toEqual([{ name: 'work', patterns: ['/work/**'] }]);
  });
});

describe('matchProjectEnvironment', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-environments-')));
    mkdirSync(join(tmp, 'work', 'acme', 'api'), { recursive: true });
    mkdirSync(join(tmp, 'work', 'acme-docs'), { recursive: true });
    mkdirSync(join(tmp, 'play'), { recursive: true });
    symlinkSync(join(tmp, 'work'), join(tmp, 'work-link'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('matches a directory below a `dir/**` pattern, and the directory itself', () => {
    const environments = [{ name: 'acme', patterns: [`${tmp}/work/acme/**`] }];
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme', 'api'), environments)).toBe('acme');
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme'), environments)).toBe('acme');
    expect(matchProjectEnvironment(join(tmp, 'play'), environments)).toBeNull();
  });

  it('returns the first matching environment', () => {
    const environments = [
      { name: 'docs', patterns: [`${tmp}/work/acme-docs`] },
      { name: 'work', patterns: [`${tmp}/work/**`] },
    ];
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme-docs'), environments)).toBe('docs');
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme', 'api'), environments)).toBe('work');
  });

  it('matches through a symlinked path whichever form the pattern uses', () => {
    const viaLink = join(tmp, 'work-link', 'acme', 'api');
    expect(matchProjectEnvironment(viaLink, [{ name: 'real', patterns: [`${tmp}/work/**`] }])).toBe('real');
    expect(matchProjectEnvironment(viaLink, [{ name: 'link', patterns: [`${tmp}/work-link/**`] }])).toBe('link');
  });

  it('expands a leading ~ in patterns', () => {
    const environments = [{ name: 'home-work', patterns: ['~/claude-mem-env-test-nonexistent/**'] }];
    expect(matchProjectEnvironment(join(homedir(), 'claude-mem-env-test-nonexistent', 'x'), environments)).toBe('home-work');
  });

  it('never matches with no environments configured', () => {
    expect(matchProjectEnvironment(join(tmp, 'work'), [])).toBeNull();
  });
});

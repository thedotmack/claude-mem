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

  it('preserves explicit empty inheritance and normalizes a selected project list', () => {
    const environments = [
      { name: 'isolated', patterns: ['/a/**'], inherit: [] },
      { name: 'shared', patterns: ['/b/**'], inherit: [' common ', 'common', 'archive'] },
    ];
    const expected = [
      environments[0],
      { name: 'shared', patterns: ['/b/**'], inherit: ['common', 'archive'] },
    ];
    expect(parseProjectEnvironments(environments)).toEqual(expected);
    expect(parseProjectEnvironments(JSON.stringify(environments))).toEqual(expected);
  });

  it.each([
    ['null', null], ['undefined', undefined], ['boolean', false], ['string', 'parent'],
    ['object', {}], ['number entry', [42]], ['empty key', ['']], ['blank key', [' ']],
    ['mixed entries', ['shared', false]], ['comma-separated key', ['shared,private']],
  ])('rejects invalid explicit inheritance (%s) instead of restoring derived reads', (_label, inherit) => {
    expect(() => parseProjectEnvironments([{ name: 'isolated', patterns: ['/a/**'], inherit }]))
      .toThrow('inherit');
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
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme', 'api'), environments)?.name).toBe('acme');
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme'), environments)?.name).toBe('acme');
    expect(matchProjectEnvironment(join(tmp, 'play'), environments)).toBeNull();
  });

  it('matches a direct child through an intermediate globstar directory', () => {
    const environments = [{ name: 'acme', patterns: [`${tmp}/**/work/acme/**`] }];
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme'), environments)?.name).toBe('acme');
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme', 'api'), environments)?.name).toBe('acme');
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme-docs'), environments)).toBeNull();
  });

  it('returns the first matching environment', () => {
    const environments = [
      { name: 'docs', patterns: [`${tmp}/work/acme-docs`] },
      { name: 'work', patterns: [`${tmp}/work/**`] },
    ];
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme-docs'), environments)?.name).toBe('docs');
    expect(matchProjectEnvironment(join(tmp, 'work', 'acme', 'api'), environments)?.name).toBe('work');
  });

  it('matches through a symlinked path whichever form the pattern uses', () => {
    const viaLink = join(tmp, 'work-link', 'acme', 'api');
    expect(matchProjectEnvironment(viaLink, [{ name: 'real', patterns: [`${tmp}/work/**`] }])?.name).toBe('real');
    expect(matchProjectEnvironment(viaLink, [{ name: 'link', patterns: [`${tmp}/work-link/**`] }])?.name).toBe('link');
  });

  it('expands a leading ~ in patterns', () => {
    const environments = [{ name: 'home-work', patterns: ['~/claude-mem-env-test-nonexistent/**'] }];
    expect(matchProjectEnvironment(join(homedir(), 'claude-mem-env-test-nonexistent', 'x'), environments)?.name).toBe('home-work');
  });

  it('never matches with no environments configured', () => {
    expect(matchProjectEnvironment(join(tmp, 'work'), [])).toBeNull();
  });
});

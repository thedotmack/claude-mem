
import { describe, it, expect } from 'bun:test';
import { isProjectExcluded, matchesAnyGlob } from '../../src/utils/project-filter.js';
import { homedir } from 'os';

describe('Project Filter', () => {
  describe('isProjectExcluded', () => {
    describe('with empty patterns', () => {
      it('returns false for empty pattern string', () => {
        expect(isProjectExcluded('/Users/test/project', '')).toBe(false);
        expect(isProjectExcluded('/Users/test/project', '   ')).toBe(false);
      });
    });

    describe('with exact path matching', () => {
      it('matches exact paths', () => {
        expect(isProjectExcluded('/tmp/secret', '/tmp/secret')).toBe(true);
        expect(isProjectExcluded('/tmp/public', '/tmp/secret')).toBe(false);
      });
    });

    describe('with * wildcard (single directory level)', () => {
      it('matches any directory name', () => {
        expect(isProjectExcluded('/tmp/secret', '/tmp/*')).toBe(true);
        expect(isProjectExcluded('/tmp/anything', '/tmp/*')).toBe(true);
      });

      it('does not match across directory boundaries', () => {
        expect(isProjectExcluded('/tmp/a/b', '/tmp/*')).toBe(false);
      });
    });

    describe('with ** wildcard (any path depth)', () => {
      it('matches any path depth', () => {
        expect(isProjectExcluded('/Users/test/kunden/client1/project', '/Users/*/kunden/**')).toBe(true);
        expect(isProjectExcluded('/Users/test/kunden/deep/nested/project', '/Users/*/kunden/**')).toBe(true);
      });
    });

    describe('with **/ matching zero or more directories', () => {
      it('excludes direct children as well as nested matches', () => {
        for (const project of ['/workspace/private', '/workspace/team/private', '/workspace/a/b/private']) {
          expect(isProjectExcluded(project, '/workspace/**/private')).toBe(true);
        }
        expect(isProjectExcluded('/workspace/private-copy', '/workspace/**/private')).toBe(false);
        expect(isProjectExcluded('/workspace/not-private', '/workspace/**/private')).toBe(false);
      });

      it('supports leading and consecutive globstar directory segments', () => {
        expect(isProjectExcluded('private', '**/private')).toBe(true);
        expect(isProjectExcluded('/workspace/private', '/workspace/**/**/private')).toBe(true);
        expect(isProjectExcluded('/workspace/a/b/private', '/workspace/**/**/private')).toBe(true);
      });

      it('normalizes home and Windows paths before matching directory segments', () => {
        expect(isProjectExcluded(`${homedir()}/private`, '~/**/private')).toBe(true);
        expect(isProjectExcluded('C:\\work\\private', 'C:\\work\\**\\private')).toBe(true);
        expect(isProjectExcluded('/workspace/private', '/workspace/*/private')).toBe(false);
      });

      it('uses the same zero-directory match for the shared deny-list matcher', () => {
        expect(matchesAnyGlob('/workspace/private', ['/workspace/**/private/**'])).toBe(true);
        expect(matchesAnyGlob('/workspace/private/cache', ['/workspace/**/private/**'])).toBe(true);
        expect(matchesAnyGlob('/workspace/private-copy', ['/workspace/**/private/**'])).toBe(false);
      });
    });

    describe('with a trailing /** (the directory itself)', () => {
      it('excludes the directory itself as well as everything under it', () => {
        expect(isProjectExcluded('/Users/test/kunden', '/Users/*/kunden/**')).toBe(true);
        expect(isProjectExcluded('/Users/test/kunden/', '/Users/*/kunden/**')).toBe(true);
        expect(isProjectExcluded('/Users/test/kunden/client1', '/Users/*/kunden/**')).toBe(true);
        expect(isProjectExcluded(`${homedir()}/customers`, '~/customers/**')).toBe(true);
        expect(isProjectExcluded('C:\\Users\\test\\kunden', 'C:\\Users\\test\\kunden\\**')).toBe(true);
      });

      it('does not exclude siblings that merely share the prefix', () => {
        expect(isProjectExcluded('/Users/test/kunden-archive', '/Users/*/kunden/**')).toBe(false);
        expect(isProjectExcluded('/Users/test', '/Users/*/kunden/**')).toBe(false);
      });

      it('leaves single-star patterns unchanged', () => {
        expect(isProjectExcluded('/tmp', '/tmp/*')).toBe(false);
      });
    });

    describe('with ? wildcard (single character)', () => {
      it('matches single character', () => {
        expect(isProjectExcluded('/tmp/a', '/tmp/?')).toBe(true);
        expect(isProjectExcluded('/tmp/ab', '/tmp/?')).toBe(false);
      });
    });

    describe('with ~ home directory expansion', () => {
      it('expands ~ to home directory', () => {
        const home = homedir();
        expect(isProjectExcluded(`${home}/secret`, '~/secret')).toBe(true);
        expect(isProjectExcluded(`${home}/projects/secret`, '~/projects/*')).toBe(true);
      });

      it('expands a Windows-form ~\\ pattern', () => {
        const home = homedir();
        // `expandHome` recognises `~` and `~/`, not `~\` on POSIX. Expanding before
        // normalising separators left a Windows-written exclusion as a literal `~/...`,
        // which matches no absolute path — so the entry silently stopped excluding.
        expect(isProjectExcluded(`${home}/projects/secret`, '~\\projects\\secret')).toBe(true);
        expect(isProjectExcluded(`${home}/projects/secret`, '~\\projects\\*')).toBe(true);
        expect(isProjectExcluded(home, '~\\')).toBe(true);
      });

      it('does not glue the home directory onto a ~name pattern', () => {
        const home = homedir();
        // `~backup/*` used to expand by concatenation to `<home>backup/*`, a path with no
        // separator between the home directory and the pattern. That excluded a sibling of
        // the home directory nobody named, and left a real `~backup` directory unexcluded.
        expect(isProjectExcluded(`${home}backup/thing`, '~backup/*')).toBe(false);
        expect(isProjectExcluded('/opt/~backup/thing', '~backup/*')).toBe(false);
      });
    });

    describe('with multiple patterns', () => {
      it('returns true if any pattern matches', () => {
        const patterns = '/tmp/*,~/kunden/*,/var/secret';
        expect(isProjectExcluded('/tmp/test', patterns)).toBe(true);
        expect(isProjectExcluded(`${homedir()}/kunden/client`, patterns)).toBe(true);
        expect(isProjectExcluded('/var/secret', patterns)).toBe(true);
        expect(isProjectExcluded('/home/user/public', patterns)).toBe(false);
      });
    });

    describe('with Windows-style paths', () => {
      it('normalizes backslashes to forward slashes', () => {
        expect(isProjectExcluded('C:\\Users\\test\\secret', 'C:/Users/*/secret')).toBe(true);
      });
    });

    describe('real-world patterns', () => {
      it('excludes customer projects', () => {
        const patterns = '~/kunden/*,~/customers/**';
        const home = homedir();

        expect(isProjectExcluded(`${home}/kunden/acme-corp`, patterns)).toBe(true);
        expect(isProjectExcluded(`${home}/customers/bigco/project1`, patterns)).toBe(true);
        expect(isProjectExcluded(`${home}/projects/opensource`, patterns)).toBe(false);
      });

      it('excludes temporary directories', () => {
        const patterns = '/tmp/*,/var/tmp/*';

        expect(isProjectExcluded('/tmp/scratch', patterns)).toBe(true);
        expect(isProjectExcluded('/var/tmp/test', patterns)).toBe(true);
        expect(isProjectExcluded('/home/user/tmp', patterns)).toBe(false);
      });
    });
  });
});

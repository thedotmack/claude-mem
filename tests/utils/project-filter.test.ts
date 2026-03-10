/**
 * Project Filter Tests
 *
 * Tests glob-based path matching for project exclusion.
 * Source: src/utils/project-filter.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { isProjectExcluded, isProjectLocallyDisabled } from '../../src/utils/project-filter.js';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

  describe('isProjectLocallyDisabled', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `claude-mem-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false when .claude-mem-disable does not exist', () => {
      expect(isProjectLocallyDisabled(tmpDir)).toBe(false);
    });

    it('returns true when .claude-mem-disable exists', () => {
      writeFileSync(join(tmpDir, '.claude-mem-disable'), '');
      expect(isProjectLocallyDisabled(tmpDir)).toBe(true);
    });

    it('returns false for empty string cwd', () => {
      expect(isProjectLocallyDisabled('')).toBe(false);
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { isDirectChild, normalizePath } from '../../../src/shared/path-utils.js';

describe('isDirectChild path matching', () => {
  describe('same path format', () => {
    test('returns true for direct child with relative paths', () => {
      expect(isDirectChild('app/api/router.py', 'app/api')).toBe(true);
    });

    test('returns true for direct child with absolute paths', () => {
      expect(isDirectChild('/Users/dev/project/app/api/router.py', '/Users/dev/project/app/api')).toBe(true);
    });

    test('returns false for files in subdirectory with relative paths', () => {
      expect(isDirectChild('app/api/v1/router.py', 'app/api')).toBe(false);
    });

    test('returns false for files in subdirectory with absolute paths', () => {
      expect(isDirectChild('/Users/dev/project/app/api/v1/router.py', '/Users/dev/project/app/api')).toBe(false);
    });

    test('returns false for unrelated paths', () => {
      expect(isDirectChild('lib/utils/helper.py', 'app/api')).toBe(false);
    });
  });

  describe('mixed path formats (absolute folder, relative file) - fixes #794', () => {
    test('returns true when absolute folder ends with relative file directory', () => {
      expect(isDirectChild('app/api/router.py', '/Users/dev/project/app/api')).toBe(true);
    });

    test('returns true for deeply nested folder match', () => {
      expect(isDirectChild('src/components/Button.tsx', '/home/user/project/src/components')).toBe(true);
    });

    test('returns false for files in subdirectory of matched folder', () => {
      expect(isDirectChild('app/api/v1/router.py', '/Users/dev/project/app/api')).toBe(false);
    });

    test('returns false when file path does not match folder suffix', () => {
      expect(isDirectChild('lib/api/router.py', '/Users/dev/project/app/api')).toBe(false);
    });
  });

  describe('path normalization', () => {
    test('handles Windows backslash paths', () => {
      expect(isDirectChild('app\\api\\router.py', 'app\\api')).toBe(true);
    });

    test('handles mixed slashes', () => {
      expect(isDirectChild('app/api\\router.py', 'app\\api')).toBe(true);
    });

    test('handles trailing slashes on folder path', () => {
      expect(isDirectChild('app/api/router.py', 'app/api/')).toBe(true);
    });

    test('handles double slashes (path normalization bug)', () => {
      expect(isDirectChild('app//api/router.py', 'app/api')).toBe(true);
    });

    test('collapses multiple consecutive slashes', () => {
      expect(isDirectChild('app///api///router.py', 'app//api//')).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('returns false for single segment file path', () => {
      expect(isDirectChild('router.py', '/Users/dev/project/app/api')).toBe(false);
    });

    test('returns false for empty paths', () => {
      expect(isDirectChild('', 'app/api')).toBe(false);
      expect(isDirectChild('app/api/router.py', '')).toBe(false);
    });

    test('handles root-level folders', () => {
      expect(isDirectChild('src/file.ts', '/project/src')).toBe(true);
    });

    test('prevents false positive from partial segment match', () => {
      expect(isDirectChild('app/api-v2/router.py', '/Users/dev/project/app/api')).toBe(false);
    });

    test('handles similar folder names correctly', () => {
      expect(isDirectChild('src/components-old/Button.tsx', '/project/src/components')).toBe(false);
    });
  });
});

describe('normalizePath', () => {
  test('converts backslashes to forward slashes', () => {
    expect(normalizePath('app\\api\\router.py')).toBe('app/api/router.py');
  });

  test('collapses consecutive slashes', () => {
    expect(normalizePath('app//api///router.py')).toBe('app/api/router.py');
  });

  test('removes trailing slashes', () => {
    expect(normalizePath('app/api/')).toBe('app/api');
    expect(normalizePath('app/api///')).toBe('app/api');
  });

  test('handles Windows UNC paths', () => {
    expect(normalizePath('\\\\server\\share\\file.txt')).toBe('/server/share/file.txt');
  });

  test('preserves leading slash for absolute paths', () => {
    expect(normalizePath('/Users/dev/project')).toBe('/Users/dev/project');
  });
});

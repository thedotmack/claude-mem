import { describe, expect, test } from 'bun:test';
import { isDirectChild, normalizePath } from '../../../src/shared/path-utils.js';

describe('isDirectChild path matching', () => {
  test.each([
    ['app/api/router.py', 'app/api', true],
    ['/Users/dev/project/app/api/router.py', '/Users/dev/project/app/api', true],
    ['app/api/v1/router.py', 'app/api', false],
    ['/Users/dev/project/app/api/v1/router.py', '/Users/dev/project/app/api', false],
    ['lib/utils/helper.py', 'app/api', false],
    ['app/api/router.py', '/Users/dev/project/app/api', true],
    ['src/components/Button.tsx', '/home/user/project/src/components', true],
    ['app/api/v1/router.py', '/Users/dev/project/app/api', false],
    ['lib/api/router.py', '/Users/dev/project/app/api', false],
    ['app\\api\\router.py', 'app\\api', true],
    ['app/api\\router.py', 'app\\api', true],
    ['app/api/router.py', 'app/api/', true],
    ['app//api/router.py', 'app/api', true],
    ['app///api///router.py', 'app//api//', true],
    ['router.py', '/Users/dev/project/app/api', false],
    ['', 'app/api', false],
    ['app/api/router.py', '', false],
    ['src/file.ts', '/project/src', true],
    ['app/api-v2/router.py', '/Users/dev/project/app/api', false],
    ['src/components-old/Button.tsx', '/project/src/components', false],
  ] as const)('matches %j within %j: %j', (file, folder, expected) => {
    expect(isDirectChild(file, folder)).toBe(expected);
  });
});

describe('normalizePath', () => {
  test.each([
    ['app\\api\\router.py', 'app/api/router.py'],
    ['app//api///router.py', 'app/api/router.py'],
    ['app/api/', 'app/api'],
    ['app/api///', 'app/api'],
    ['\\\\server\\share\\file.txt', '/server/share/file.txt'],
    ['/Users/dev/project', '/Users/dev/project'],
  ] as const)('normalizes %j to %j', (path, expected) => {
    expect(normalizePath(path)).toBe(expected);
  });
});

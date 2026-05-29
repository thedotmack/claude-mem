import { describe, test, expect, afterEach } from 'bun:test';
import { getProjectName } from '../src/utils/project-name.js';

describe('getProjectName environment matching', () => {
  test('no environments configured — falls back to basename', () => {
    const cwd = '/Users/test/company-a';
    expect(getProjectName(cwd)).toBe('company-a');
  });

  test('empty cwd — returns unknown-project', () => {
    expect(getProjectName(null)).toBe('unknown-project');
    expect(getProjectName('')).toBe('unknown-project');
  });

  test('windows drive root — returns drive-X', () => {
    expect(getProjectName('C:\\')).toBe('drive-C');
  });

  // These tests will verify environment matching once implemented (Task 3)
  // They currently test basename fallback behavior
  test('simple directory basename', () => {
    expect(getProjectName('/home/user/my-project')).toBe('my-project');
  });

  test('trailing slash stripped in basename', () => {
    expect(getProjectName('/home/user/my-project/')).toBe('my-project');
  });
});
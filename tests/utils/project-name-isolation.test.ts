import { describe, it, expect } from 'bun:test';
import { getProjectName } from '../../src/utils/project-name.js';

describe('getProjectName mock isolation (#1299)', () => {
  it('returns real basename, not the leaked test-project mock', () => {
    expect(getProjectName('/real/path/to/my-project')).toBe('my-project');
  });

  it('returns unknown-project for empty string (real implementation)', () => {
    expect(getProjectName('')).toBe('unknown-project');
  });

  it('returns real basename from nested path', () => {
    expect(getProjectName('/home/user/code/awesome-app')).toBe('awesome-app');
  });
});

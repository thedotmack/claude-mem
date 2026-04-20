/**
 * Regression test for mock.module() worker pollution (#1299)
 *
 * context-reinjection-guard.test.ts used to call mock.module('../../src/utils/project-name.js', ...)
 * at the top level, which permanently stubbed getProjectName to return 'test-project'
 * for every subsequent import in the same Bun worker process.
 *
 * Without bunfig.toml [test] smol=true, this test would fail when Bun scheduled
 * it in the same worker as context-reinjection-guard.test.ts, because the module
 * was mocked before these tests ran and getProjectName() returned 'test-project'
 * instead of the real extracted basename.
 */
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

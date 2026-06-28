import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import { normalize } from 'path';

// Mock loadFromFileOnce to avoid real file I/O and settings-dependent results
mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

// Import after mock so the module picks up the mocked dependency
const { shouldTrackProject } = await import('../../src/shared/should-track-project.js');

describe('shouldTrackProject — path normalization', () => {
  let savedInternal: string | undefined;

  beforeEach(() => {
    savedInternal = process.env.CLAUDE_MEM_INTERNAL;
    delete process.env.CLAUDE_MEM_INTERNAL;
  });

  afterEach(() => {
    if (savedInternal !== undefined) {
      process.env.CLAUDE_MEM_INTERNAL = savedInternal;
    } else {
      delete process.env.CLAUDE_MEM_INTERNAL;
    }
  });

  it('returns false when cwd matches OBSERVER_SESSIONS_DIR with forward slashes', () => {
    // Hooks may pass forward-slash paths on Windows; normalize() handles this
    const forwardSlash = OBSERVER_SESSIONS_DIR.replace(/\\/g, '/');
    expect(shouldTrackProject(forwardSlash)).toBe(false);
  });

  it('returns false when cwd is a subdirectory of OBSERVER_SESSIONS_DIR (mixed separators)', () => {
    const forwardSlash = OBSERVER_SESSIONS_DIR.replace(/\\/g, '/');
    expect(shouldTrackProject(forwardSlash + '/some-session')).toBe(false);
  });

  it('returns false when cwd matches OBSERVER_SESSIONS_DIR exactly (native separators)', () => {
    expect(shouldTrackProject(OBSERVER_SESSIONS_DIR)).toBe(false);
  });

  it('returns true for an unrelated project path', () => {
    const unrelated = normalize('/tmp/my-project');
    expect(shouldTrackProject(unrelated)).toBe(true);
  });

  it('returns false when CLAUDE_MEM_INTERNAL is set', () => {
    process.env.CLAUDE_MEM_INTERNAL = '1';
    expect(shouldTrackProject('/any/path')).toBe(false);
  });
});

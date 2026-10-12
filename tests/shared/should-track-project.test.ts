import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { CLAUDE_CONFIG_DIR, MARKETPLACE_ROOT, OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import { join, normalize } from 'path';

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so this partial hook-settings stub would
// otherwise leak into other test files in the same `bun test` run.
import * as realHookSettings from '../../src/shared/hook-settings.js';
const realHookSettingsSnapshot = { ...realHookSettings };

// Mock loadFromFileOnce to avoid real file I/O and settings-dependent results
mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
});

// Import after mock so the module picks up the mocked dependency
const { shouldTrackProject } = await import('../../src/shared/should-track-project.js');

const PLUGINS_DIR_NAME = 'plugins';
const PLUGIN_CACHE_DIR_NAME = 'cache';
const CLAUDE_MEM_PLUGIN_OWNER = 'thedotmack';
const CLAUDE_MEM_PLUGIN_NAME = 'claude-mem';
const PLUGIN_VERSION_DIR_NAME = '13.12.4';
const PLUGIN_RUNTIME_DIR_NAME = 'plugin';
const PLUGIN_SCRIPTS_DIR_NAME = 'scripts';

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

  it('returns false when cwd is inside the installed plugin cache', () => {
    const pluginVersionDir = join(
      CLAUDE_CONFIG_DIR,
      PLUGINS_DIR_NAME,
      PLUGIN_CACHE_DIR_NAME,
      CLAUDE_MEM_PLUGIN_OWNER,
      CLAUDE_MEM_PLUGIN_NAME,
      PLUGIN_VERSION_DIR_NAME,
    );

    expect(shouldTrackProject(pluginVersionDir)).toBe(false);
    expect(shouldTrackProject(join(pluginVersionDir, PLUGIN_RUNTIME_DIR_NAME, PLUGIN_SCRIPTS_DIR_NAME))).toBe(false);
  });

  it('returns false when cwd is inside the marketplace plugin runtime', () => {
    const marketplacePluginDir = join(MARKETPLACE_ROOT, PLUGIN_RUNTIME_DIR_NAME);

    expect(shouldTrackProject(marketplacePluginDir)).toBe(false);
    expect(shouldTrackProject(join(marketplacePluginDir, PLUGIN_SCRIPTS_DIR_NAME))).toBe(false);
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

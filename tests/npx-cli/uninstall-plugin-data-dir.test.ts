import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeStrayClaudeMemPaths } from '../../src/npx-cli/commands/uninstall.js';

/**
 * Claude Code keeps a plugin's data directory under the active config dir
 * (`$CLAUDE_CONFIG_DIR/plugins/data/<plugin>-<marketplace>`). Uninstall must
 * remove that one, and must not touch `~/.claude`, which belongs to a different
 * profile when CLAUDE_CONFIG_DIR is set.
 */
describe('uninstall: plugin data directory', () => {
  let fixture: string;
  let home: string;
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'claude-mem-uninstall-plugin-data-'));
    home = join(fixture, 'home');
    configDir = join(fixture, 'custom-claude');
    mkdirSync(home, { recursive: true });
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    rmSync(fixture, { recursive: true, force: true });
  });

  it('removes the data dir under CLAUDE_CONFIG_DIR and leaves ~/.claude alone', () => {
    const activeDataDir = join(configDir, 'plugins', 'data', 'claude-mem-thedotmack');
    const otherProfileDataDir = join(home, '.claude', 'plugins', 'data', 'claude-mem-thedotmack');
    mkdirSync(activeDataDir, { recursive: true });
    mkdirSync(otherProfileDataDir, { recursive: true });

    expect(removeStrayClaudeMemPaths(home)).toBe(1);

    expect(existsSync(activeDataDir)).toBe(false);
    expect(existsSync(otherProfileDataDir)).toBe(true);
  });
});

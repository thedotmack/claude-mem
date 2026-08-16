import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeFromClaudeSettings } from '../src/npx-cli/commands/uninstall.js';

/**
 * Tests for the uninstaller's cleanup of ~/.claude/settings.json.
 *
 * Closes thedotmack/claude-mem#2579: the installer writes
 * env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1" to suppress Claude Code's
 * built-in auto-memory while claude-mem is active. The uninstaller must
 * remove that key symmetrically so the host CLI's auto-memory is restored
 * to its default state after `claude-mem uninstall`.
 *
 * Runtime-only — mirrors install-disable-auto-memory.test.ts, using a
 * CLAUDE_CONFIG_DIR override so the user's real settings are never
 * touched. Earlier revisions also had three regex-based source-inspection
 * tests; greptile (PR #2630) flagged them as fragile (the lazy `\n\}`
 * anchor breaks silently on refactors with nested column-0 braces or an
 * indented function declaration), so they were dropped in favour of the
 * behavioural assertions below, which are strictly stronger.
 */

describe('Uninstall: clear Claude Code auto-memory env var', () => {
  describe('removeFromClaudeSettings runtime behavior', () => {
    let tempDir: string;
    let originalConfigDir: string | undefined;
    let settingsPath: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-uninstall-auto-memory-'));
      originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;
      settingsPath = join(tempDir, 'settings.json');
    });

    afterEach(() => {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('PR #2630: preserves a pre-existing CLAUDE_CODE_DISABLE_AUTO_MEMORY value that is not "1"', () => {
      // The installer only ever writes the literal token "1" and no-ops if
      // it already finds "1" present. So during uninstall we only strip the
      // key when its value is exactly "1" — any other value (e.g. "0" to
      // force auto-memory ON, or some unrelated truthy token the user set
      // themselves) is user intent that must be preserved, not clobbered.
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', AWS_REGION: 'us-east-1' },
        }, null, 2),
      );
      const before = readFileSync(settingsPath, 'utf-8');

      removeFromClaudeSettings();

      // No write should have occurred — user's value is untouched.
      const after = readFileSync(settingsPath, 'utf-8');
      expect(after).toBe(before);
      const settings = JSON.parse(after);
      expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
      expect(settings.env.AWS_REGION).toBe('us-east-1');
    });

    it('removes CLAUDE_CODE_DISABLE_AUTO_MEMORY from the env block', () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        }, null, 2),
      );

      removeFromClaudeSettings();

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    });

    it('drops the entire env block when CLAUDE_CODE_DISABLE_AUTO_MEMORY was the only key', () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          theme: 'dark',
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        }, null, 2),
      );

      removeFromClaudeSettings();

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.env).toBeUndefined();
      // Other top-level keys must survive
      expect(settings.theme).toBe('dark');
    });

    it('preserves other env vars the user added themselves', () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: {
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            ANTHROPIC_AUTH_TOKEN: 'sk-test',
            AWS_REGION: 'us-east-1',
          },
        }, null, 2),
      );

      removeFromClaudeSettings();

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
      expect(settings.env.AWS_REGION).toBe('us-east-1');
    });

    it('also removes the plugin registration in enabledPlugins (existing behavior)', () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          enabledPlugins: { 'claude-mem@thedotmack': true, 'other-plugin@vendor': true },
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        }, null, 2),
      );

      removeFromClaudeSettings();

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.enabledPlugins['claude-mem@thedotmack']).toBeUndefined();
      expect(settings.enabledPlugins['other-plugin@vendor']).toBe(true);
      expect(settings.env).toBeUndefined();
    });

    it('is a no-op when neither the plugin nor the env var are present', () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ theme: 'dark', env: { AWS_REGION: 'us-east-1' } }, null, 2),
      );
      const before = readFileSync(settingsPath, 'utf-8');

      removeFromClaudeSettings();

      // File should be untouched (no write occurred).
      const after = readFileSync(settingsPath, 'utf-8');
      expect(after).toBe(before);
    });

    it('does not crash when settings.json is missing', () => {
      expect(existsSync(settingsPath)).toBe(false);
      expect(() => removeFromClaudeSettings()).not.toThrow();
    });

    it('tolerates a malformed (non-object) env value', () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ env: 'not-an-object', theme: 'dark' }, null, 2),
      );

      expect(() => removeFromClaudeSettings()).not.toThrow();

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.theme).toBe('dark');
      // Malformed env value is left alone — we only act on object-shaped envs.
      expect(settings.env).toBe('not-an-object');
    });
  });
});

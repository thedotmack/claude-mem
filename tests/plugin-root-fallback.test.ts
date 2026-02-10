/**
 * Tests for CLAUDE_PLUGIN_ROOT fallback resolution.
 *
 * Verifies that hooks.json commands include a fallback path when
 * CLAUDE_PLUGIN_ROOT is not set by Claude Code, and that bun-runner.js
 * can derive the plugin root from its own script location.
 *
 * Fixes #1044: Hooks fail when CLAUDE_PLUGIN_ROOT not set
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

const PROJECT_ROOT = join(dirname(import.meta.dir), '');
const HOOKS_JSON_PATH = join(PROJECT_ROOT, 'plugin', 'hooks', 'hooks.json');
const BUN_RUNNER_PATH = join(PROJECT_ROOT, 'plugin', 'scripts', 'bun-runner.js');

const FALLBACK_PATH = '$HOME/.claude/plugins/marketplaces/thedotmack';
const FALLBACK_PATTERN = `\${CLAUDE_PLUGIN_ROOT:-${FALLBACK_PATH}}`;

describe('CLAUDE_PLUGIN_ROOT fallback (#1044)', () => {
  describe('hooks.json fallback commands', () => {
    let hooksConfig: any;

    it('should parse hooks.json without errors', () => {
      const content = readFileSync(HOOKS_JSON_PATH, 'utf-8');
      hooksConfig = JSON.parse(content);
      expect(hooksConfig).toBeDefined();
      expect(hooksConfig.hooks).toBeDefined();
    });

    it('should have fallback in every hook command that references CLAUDE_PLUGIN_ROOT', () => {
      const content = readFileSync(HOOKS_JSON_PATH, 'utf-8');
      hooksConfig = JSON.parse(content);

      const allCommands: string[] = [];
      for (const [hookName, hookGroups] of Object.entries(hooksConfig.hooks)) {
        for (const group of hookGroups as any[]) {
          for (const hook of group.hooks || []) {
            if (hook.command) {
              allCommands.push(hook.command);
            }
          }
        }
      }

      expect(allCommands.length).toBeGreaterThan(0);

      for (const command of allCommands) {
        // Every command should NOT have bare ${CLAUDE_PLUGIN_ROOT} without fallback
        // Instead it should use the _P variable pattern with fallback
        expect(command).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}(?!.*:-)/);

        // Every command should contain the fallback pattern
        expect(command).toContain(FALLBACK_PATH);
      }
    });

    it('should use consistent fallback path across all commands', () => {
      const content = readFileSync(HOOKS_JSON_PATH, 'utf-8');
      hooksConfig = JSON.parse(content);

      const allCommands: string[] = [];
      for (const hookGroups of Object.values(hooksConfig.hooks)) {
        for (const group of hookGroups as any[]) {
          for (const hook of group.hooks || []) {
            if (hook.command) {
              allCommands.push(hook.command);
            }
          }
        }
      }

      // Every command should use the same fallback path
      for (const command of allCommands) {
        const fallbackMatches = command.match(/\$HOME\/\.claude\/plugins\/marketplaces\/thedotmack/g);
        expect(fallbackMatches).not.toBeNull();
        expect(fallbackMatches!.length).toBeGreaterThan(0);
      }
    });

    it('should have all expected hook types defined', () => {
      const content = readFileSync(HOOKS_JSON_PATH, 'utf-8');
      hooksConfig = JSON.parse(content);

      const expectedHooks = ['Setup', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];
      for (const hookName of expectedHooks) {
        expect(hooksConfig.hooks[hookName]).toBeDefined();
        expect(Array.isArray(hooksConfig.hooks[hookName])).toBe(true);
      }
    });
  });

  describe('bun-runner.js CLAUDE_PLUGIN_ROOT resolution', () => {
    it('should contain CLAUDE_PLUGIN_ROOT derivation logic', () => {
      const content = readFileSync(BUN_RUNNER_PATH, 'utf-8');

      // Should check for CLAUDE_PLUGIN_ROOT in env
      expect(content).toContain('process.env.CLAUDE_PLUGIN_ROOT');

      // Should derive from __dirname when not set
      expect(content).toContain('dirname(__dirname)');

      // Should set the env var for child processes
      expect(content).toContain('process.env.CLAUDE_PLUGIN_ROOT = derivedPluginRoot');
    });

    it('should have debug logging for both env var and fallback paths', () => {
      const content = readFileSync(BUN_RUNNER_PATH, 'utf-8');

      // Should log when using env var
      expect(content).toContain('CLAUDE_PLUGIN_ROOT from env');

      // Should log when using derived path
      expect(content).toContain('CLAUDE_PLUGIN_ROOT derived from script location');
    });

    it('should import dirname and fileURLToPath for path resolution', () => {
      const content = readFileSync(BUN_RUNNER_PATH, 'utf-8');

      expect(content).toContain("import { fileURLToPath } from 'url'");
      expect(content).toContain('dirname');
    });
  });
});

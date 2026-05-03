import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for auto-memory disable behavior in the install command.
 *
 * Closes anthropics/claude-code#23544 from claude-mem's side: any install that
 * targets claude-code must set CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in
 * ~/.claude/settings.json `env` block. The built-in MEMORY.md system creates
 * shadow state outside the user's control and competes with claude-mem's
 * hook-based memory for context-window tokens.
 *
 * Source-inspection style mirrors install-non-tty.test.ts — disableClaudeAutoMemory
 * is a private module-level helper that can't be imported directly.
 */

const installSourcePath = join(
  __dirname,
  '..',
  'src',
  'npx-cli',
  'commands',
  'install.ts',
);
const installSource = readFileSync(installSourcePath, 'utf-8');

describe('Install: disable Claude Code auto-memory', () => {
  describe('disableClaudeAutoMemory helper', () => {
    it('defines the helper function', () => {
      expect(installSource).toContain('function disableClaudeAutoMemory()');
    });

    it('writes CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 to settings.json env block', () => {
      // The string '1' (not boolean true) is required — env vars are always strings.
      expect(installSource).toMatch(/CLAUDE_CODE_DISABLE_AUTO_MEMORY:\s*['"]1['"]/);
    });

    it('reads existing settings via readJsonSafe (preserves other keys)', () => {
      // Must round-trip through readJsonSafe + writeJsonFileAtomic, never overwrite blindly.
      const helperBody = installSource.match(
        /function disableClaudeAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toBeDefined();
      expect(helperBody).toContain('readJsonSafe');
      expect(helperBody).toContain('writeJsonFileAtomic(claudeSettingsPath()');
    });

    it('merges with existing env vars instead of replacing the env block', () => {
      // Spread of existing env into new env is what preserves user-set vars
      // like ANTHROPIC_AUTH_TOKEN, AWS_REGION, etc.
      const helperBody = installSource.match(
        /function disableClaudeAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toMatch(/\.\.\.env/);
    });

    it('is idempotent — returns false (no write) when already set to "1"', () => {
      const helperBody = installSource.match(
        /function disableClaudeAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toMatch(/CLAUDE_CODE_DISABLE_AUTO_MEMORY === ['"]1['"]/);
      expect(helperBody).toMatch(/return false/);
    });

    it('returns true after a successful write', () => {
      const helperBody = installSource.match(
        /function disableClaudeAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toMatch(/return true/);
    });
  });

  describe('runInstallCommand integration', () => {
    it('calls disableClaudeAutoMemory after setupIDEs', () => {
      // setupIDEs returns first; we need its result before deciding what to do,
      // and the disable step shouldn't run if claude-code wasn't installed.
      // Use lastIndexOf for the call so we match the call site, not the helper definition.
      const setupCallIdx = installSource.indexOf('await setupIDEs(selectedIDEs)');
      const disableCallIdx = installSource.lastIndexOf('disableClaudeAutoMemory()');
      expect(setupCallIdx).toBeGreaterThan(-1);
      expect(disableCallIdx).toBeGreaterThan(-1);
      expect(disableCallIdx).toBeGreaterThan(setupCallIdx);
    });

    it("only runs the disable step when claude-code is in selectedIDEs", () => {
      // Cursor/Codex/Windsurf installs shouldn't touch ~/.claude/settings.json
      // for an env var that doesn't apply to them.
      expect(installSource).toMatch(
        /selectedIDEs\.includes\(['"]claude-code['"]\)[\s\S]{0,200}disableClaudeAutoMemory\(\)/,
      );
    });

    it('catches errors from disableClaudeAutoMemory and continues', () => {
      // Settings.json is the user's file — a write failure (permissions, disk
      // full, etc.) must surface as a warning, not abort the install.
      const integrationBlock = installSource.match(
        /selectedIDEs\.includes\(['"]claude-code['"]\)[\s\S]{0,800}/,
      )?.[0];
      expect(integrationBlock).toBeDefined();
      expect(integrationBlock).toContain('try {');
      expect(integrationBlock).toContain('autoMemoryDisabled = disableClaudeAutoMemory()');
      expect(integrationBlock).toContain('catch');
      expect(integrationBlock).toMatch(/log\.warn/);
    });

    it('surfaces the result in the install summary when a write happened', () => {
      // Users should see exactly what the installer did to their settings.
      expect(installSource).toMatch(
        /if \(autoMemoryDisabled\)[\s\S]{0,300}CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/,
      );
    });
  });
});

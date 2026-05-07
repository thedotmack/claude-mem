import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { disableClaudeAutoMemory } from '../src/npx-cli/commands/install.js';

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
      expect(integrationBlock).toMatch(/const wrote = disableClaudeAutoMemory\(\)/);
      expect(integrationBlock).toContain('catch');
      expect(integrationBlock).toMatch(/log\.warn/);
    });

    it('tracks a tri-state autoMemoryStatus (disabled / already-disabled / failed)', () => {
      // A boolean would conflate the error path with "already set", so a write
      // failure mid-install would silently render "already disabled" in the
      // summary while the warning above said the opposite. Tri-state keeps the
      // log line and the summary line truthful and consistent.
      expect(installSource).toMatch(
        /let autoMemoryStatus:\s*['"]disabled['"]\s*\|\s*['"]already-disabled['"]\s*\|\s*['"]failed['"]\s*\|\s*null/,
      );
      const integrationBlock = installSource.match(
        /selectedIDEs\.includes\(['"]claude-code['"]\)[\s\S]{0,800}/,
      )?.[0];
      expect(integrationBlock).toMatch(/autoMemoryStatus = wrote \? ['"]disabled['"] : ['"]already-disabled['"]/);
      expect(integrationBlock).toMatch(/autoMemoryStatus = ['"]failed['"]/);
    });

    it('surfaces all three states in the install summary distinctly', () => {
      // The error case must NOT render as "already disabled" — that would
      // contradict the warn line above it and falsely imply the env var is set.
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]disabled['"][\s\S]{0,200}CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/,
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]already-disabled['"][\s\S]{0,200}already disabled/,
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]failed['"][\s\S]{0,200}write failed/,
      );
    });
  });

  // Behavioral test that exercises real file I/O against a temp Claude config dir.
  // Complements the source-inspection tests above: catches runtime bugs (overwriting
  // env block, dropping existing keys, non-string values, etc.) that string matching
  // can't see. Uses CLAUDE_CONFIG_DIR override so we don't touch the user's settings.
  describe('disableClaudeAutoMemory runtime behavior', () => {
    let tempDir: string;
    let originalConfigDir: string | undefined;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-disable-auto-memory-'));
      originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempDir;
    });

    afterEach(() => {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('writes the env var when settings.json is missing', () => {
      const wrote = disableClaudeAutoMemory();
      expect(wrote).toBe(true);

      const settings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });

    it('preserves existing env vars and other top-level keys', () => {
      writeFileSync(
        join(tempDir, 'settings.json'),
        JSON.stringify({
          theme: 'dark',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-test',
            AWS_REGION: 'us-east-1',
          },
          permissions: { defaultMode: 'auto' },
        }, null, 2),
      );

      const wrote = disableClaudeAutoMemory();
      expect(wrote).toBe(true);

      const settings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      expect(settings.theme).toBe('dark');
      expect(settings.permissions).toEqual({ defaultMode: 'auto' });
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
      expect(settings.env.AWS_REGION).toBe('us-east-1');
      expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });

    it('is idempotent — second call returns false and leaves the file untouched', () => {
      const firstWrite = disableClaudeAutoMemory();
      expect(firstWrite).toBe(true);

      const settingsPath = join(tempDir, 'settings.json');
      const contentBefore = readFileSync(settingsPath, 'utf-8');

      const secondWrite = disableClaudeAutoMemory();
      expect(secondWrite).toBe(false);

      const contentAfter = readFileSync(settingsPath, 'utf-8');
      expect(contentAfter).toBe(contentBefore);
    });

    it('writes the literal string "1", not boolean true', () => {
      // Env vars are always strings — boolean true would be coerced unpredictably
      // by Claude Code's env loader.
      disableClaudeAutoMemory();
      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      expect(raw).toMatch(/"CLAUDE_CODE_DISABLE_AUTO_MEMORY":\s*"1"/);
      expect(raw).not.toMatch(/"CLAUDE_CODE_DISABLE_AUTO_MEMORY":\s*true/);
    });

    it('replaces a non-object env value with a fresh env block', () => {
      // Defensive: if settings.env is malformed (string, null, array), the helper
      // still has to land on a valid object containing the env var.
      writeFileSync(
        join(tempDir, 'settings.json'),
        JSON.stringify({ env: 'not-an-object', theme: 'dark' }),
      );

      const wrote = disableClaudeAutoMemory();
      expect(wrote).toBe(true);

      const settings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      expect(settings.theme).toBe('dark');
      expect(typeof settings.env).toBe('object');
      expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });
  });
});

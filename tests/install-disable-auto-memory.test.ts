import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { disableClaudeAutoMemory } from '../src/npx-cli/commands/install.js';

/**
 * Tests for auto-memory disable behavior in the install command.
 *
 * Closes anthropics/claude-code#23544 from claude-mem's side: installs now
 * require explicit consent before setting CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in
 * ~/.claude/settings.json `env` block. The built-in MEMORY.md system creates
 * shadow state outside the user's control and competes with claude-mem's
 * hook-based memory for context-window tokens, but we should not disable it
 * without the user's opt-in.
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
      expect(installSource).toMatch(/CLAUDE_CODE_DISABLE_AUTO_MEMORY:\s*['"]1['"]/);
    });

    it('reads existing settings via readJsonSafe (preserves other keys)', () => {
      const helperBody = installSource.match(
        /function disableClaudeAutoMemory\(\)[\s\S]*?\n\}/,
      )?.[0];
      expect(helperBody).toBeDefined();
      expect(helperBody).toContain('readJsonSafe');
      expect(helperBody).toContain('writeJsonFileAtomic(claudeSettingsPath()');
    });

    it('merges with existing env vars instead of replacing the env block', () => {
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
    it('resolves auto-memory choice after setupIDEs', () => {
      const setupCallIdx = installSource.indexOf('await setupIDEs(selectedIDEs');
      const choiceCallIdx = installSource.indexOf('await resolveClaudeAutoMemoryChoice(selectedIDEs, options)');
      expect(setupCallIdx).toBeGreaterThan(-1);
      expect(choiceCallIdx).toBeGreaterThan(-1);
      expect(choiceCallIdx).toBeGreaterThan(setupCallIdx);
    });

    it('skips the consent helper entirely when claude-code is not selected', () => {
      expect(installSource).toMatch(
        /if \(!selectedIDEs\.includes\(['"]claude-code['"]\)\) \{\s*return ['"]not-applicable['"]/
      );
    });

    it('only calls disableClaudeAutoMemory after an explicit disable decision', () => {
      expect(installSource).toMatch(
        /if \(autoMemoryChoice === ['"]disable['"]\)[\s\S]{0,300}disableClaudeAutoMemory\(\)/
      );
    });

    it('leaves auto-memory enabled in non-interactive installs unless the explicit flag is present', () => {
      expect(installSource).toMatch(
        /if \(!isInteractive\) \{\s*return ['"]leave-enabled['"]/
      );
      expect(installSource).toMatch(
        /if \(options\.disableAutoMemory\) \{\s*return ['"]disable['"]/
      );
    });

    it('catches errors from disableClaudeAutoMemory and continues', () => {
      const integrationBlock = installSource.match(
        /if \(autoMemoryChoice === ['"]disable['"]\)[\s\S]{0,800}/
      )?.[0];
      expect(integrationBlock).toBeDefined();
      expect(integrationBlock).toContain('try {');
      expect(integrationBlock).toMatch(/const wrote = disableClaudeAutoMemory\(\)/);
      expect(integrationBlock).toContain('catch');
      expect(integrationBlock).toMatch(/installerError\(ErrorSeverity\.WARN_CONTINUE/);
    });

    it('tracks a four-state autoMemoryStatus (disabled / already-disabled / left-enabled / failed)', () => {
      expect(installSource).toMatch(
        /let autoMemoryStatus:\s*['"]disabled['"]\s*\|\s*['"]already-disabled['"]\s*\|\s*['"]left-enabled['"]\s*\|\s*['"]failed['"]\s*\|\s*null/
      );
      const integrationBlock = installSource.match(/autoMemoryChoice[\s\S]{0,1200}/)?.[0];
      expect(integrationBlock).toMatch(/autoMemoryStatus = wrote \? ['"]disabled['"] : ['"]already-disabled['"]/);
      expect(integrationBlock).toMatch(/autoMemoryStatus = ['"]left-enabled['"]/);
      expect(integrationBlock).toMatch(/autoMemoryStatus = ['"]failed['"]/);
    });

    it('surfaces disabled, already-disabled, left-enabled, and failed states in the install summary distinctly', () => {
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]disabled['"][\s\S]{0,200}CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]already-disabled['"][\s\S]{0,200}already disabled/
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]left-enabled['"][\s\S]{0,200}left enabled/
      );
      expect(installSource).toMatch(
        /autoMemoryStatus === ['"]failed['"][\s\S]{0,200}write failed/
      );
    });
  });

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
      disableClaudeAutoMemory();
      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      expect(raw).toMatch(/"CLAUDE_CODE_DISABLE_AUTO_MEMORY":\s*"1"/);
      expect(raw).not.toMatch(/"CLAUDE_CODE_DISABLE_AUTO_MEMORY":\s*true/);
    });

    it('replaces a non-object env value with a fresh env block', () => {
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

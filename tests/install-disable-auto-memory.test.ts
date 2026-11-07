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
 * The consent gate (resolveClaudeAutoMemoryChoice) is a private module-level
 * helper that prompts on a TTY, so its rules are pinned by source inspection;
 * disableClaudeAutoMemory itself is exercised directly below.
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
  describe('runInstallCommand integration', () => {
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

// Hook launcher placement (plan-17 #3605, Phase 3). Behavior is covered in
// tests/launcher/install-launcher.test.ts; these pin the installer wiring.
describe('Install: claude-mem hook launcher placement', () => {
  it('places the launcher in the runtime-setup task, after ensureBun and from the cached plugin', () => {
    const runtimeTaskStart = installSource.indexOf("title: 'Setting up runtime (first install can take ~30s)'");
    const ensureBunCall = installSource.indexOf('await ensureBun(summary)', runtimeTaskStart);
    const launcherCall = installSource.indexOf('placeHookLauncherOnPath(cacheDir, summary)', runtimeTaskStart);
    expect(runtimeTaskStart).toBeGreaterThan(-1);
    expect(ensureBunCall).toBeGreaterThan(runtimeTaskStart);
    expect(launcherCall).toBeGreaterThan(ensureBunCall);
  });
});

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for the non-TTY detection in the install command.
 *
 * The install command (src/npx-cli/commands/install.ts) has non-interactive
 * fallbacks so it works in CI/CD, Docker, and piped environments where
 * process.stdin.isTTY is undefined.
 *
 * Since isInteractive, runTasks, and log are not exported, we verify
 * their presence and correctness via source inspection. This is a valid
 * approach for testing private module-level constructs that can't be
 * imported directly.
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

describe('Install Non-TTY Support', () => {
  describe('isInteractive flag', () => {
    it('defines isInteractive based on process.stdin.isTTY', () => {
      expect(installSource).toContain('const isInteractive = process.stdin.isTTY === true');
    });

    it('uses strict equality (===) not truthy check for isTTY', () => {
      // Ensures undefined isTTY is treated as false, not just falsy
      const match = installSource.match(/const isInteractive = process\.stdin\.isTTY === true/);
      expect(match).not.toBeNull();
    });
  });

  describe('runTasks helper', () => {
    it('defines a runTasks function', () => {
      expect(installSource).toContain('async function runTasks');
    });

    it('has interactive branch using p.tasks', () => {
      expect(installSource).toContain('await p.tasks(tasks)');
    });

    it('has non-interactive fallback using console.log', () => {
      // In non-TTY mode, tasks iterate and log output directly
      expect(installSource).toContain('console.log(`  ${msg}`)');
    });

    it('branches on isInteractive', () => {
      expect(installSource).toContain('if (isInteractive)');
    });
  });

  describe('log wrapper', () => {
    it('defines log.info that falls back to console.log', () => {
      expect(installSource).toContain('info: (msg: string) =>');
      // Should have console.log fallback
      expect(installSource).toMatch(/info:.*console\.log/);
    });

    it('defines log.success that falls back to console.log', () => {
      expect(installSource).toContain('success: (msg: string) =>');
      expect(installSource).toMatch(/success:.*console\.log/);
    });

    it('defines log.warn that falls back to console.warn', () => {
      expect(installSource).toContain('warn: (msg: string) =>');
      expect(installSource).toMatch(/warn:.*console\.warn/);
    });

    it('defines log.error that falls back to console.error', () => {
      expect(installSource).toContain('error: (msg: string) =>');
      expect(installSource).toMatch(/error:.*console\.error/);
    });
  });

  describe('non-interactive install path', () => {
    it('defaults to claude-code when not interactive and no IDE specified', () => {
      // The non-interactive path should have a fallback
      expect(installSource).toContain("selectedIDEs = ['claude-code']");
    });

    it('uses console.log for intro in non-interactive mode', () => {
      expect(installSource).toContain("console.log('claude-mem install')");
    });

    it('uses console.log for note/summary in non-interactive mode', () => {
      expect(installSource).toContain("console.log(`\\n  ${installStatus}`)");
    });
  });

  describe('TaskDescriptor interface', () => {
    it('defines a task interface with title and task function', () => {
      expect(installSource).toContain('interface TaskDescriptor');
      expect(installSource).toContain('title: string');
      expect(installSource).toContain('task: (message: (msg: string) => void) => Promise<string>');
    });
  });

  describe('InstallOptions interface', () => {
    it('exports InstallOptions with optional ide field', () => {
      expect(installSource).toContain('export interface InstallOptions');
      expect(installSource).toContain('ide?: string');
    });
  });
});

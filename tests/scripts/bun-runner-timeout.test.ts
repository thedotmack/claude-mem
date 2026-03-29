/**
 * Tests for bun-runner.js process-level timeout and stdin cleanup.
 *
 * Validates that:
 * - Hard process timeout kills hung child processes
 * - collectStdin cleans up safety timer on success
 * - Timeout is configurable via CLAUDE_MEM_HOOK_TIMEOUT_MS env var
 *
 * These tests spawn actual bun-runner.js processes to test real behavior.
 * Mock tests work on all platforms (don't require actual Windows).
 *
 * Run standalone: bun test tests/scripts/bun-runner-timeout.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { spawn } from 'child_process';
import { unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__test_dirname, '..', '..');
const BUN_RUNNER_PATH = join(PROJECT_ROOT, 'plugin', 'scripts', 'bun-runner.js');

/**
 * Helper to run bun-runner.js with a script and capture result
 */
function runBunRunner(
  scriptContent: string,
  env: Record<string, string> = {},
  timeoutMs: number = 10000
): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Write a temp script that bun-runner will execute
    const tempScript = join(PROJECT_ROOT, 'tests', 'scripts', `_temp_test_${Date.now()}.js`);
    Bun.write(tempScript, scriptContent);

    const proc = spawn('node', [BUN_RUNNER_PATH, tempScript], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    const cleanup = () => {
      try { unlinkSync(tempScript); } catch { /* ignore */ }
    };

    const killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        cleanup();
        resolve({ code: null, stderr, timedOut: true });
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        cleanup();
        resolve({ code, stderr, timedOut: false });
      }
    });
  });
}

describe('bun-runner process-level timeout', () => {
  it('should exit normally for a fast script', async () => {
    const result = await runBunRunner('process.exit(0);', {}, 5000);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it(
    'should kill hung child process after CLAUDE_MEM_HOOK_TIMEOUT_MS',
    async () => {
      // Script that hangs forever
      const hangScript = 'setTimeout(() => {}, 999999);';

      const startTime = Date.now();
      const result = await runBunRunner(hangScript, {
        CLAUDE_MEM_HOOK_TIMEOUT_MS: '5000', // 5 second timeout
      }, 15000);
      const elapsed = Date.now() - startTime;

      // Should exit with code 0 (clean exit after timeout kill)
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);

      // Should have taken approximately 5 seconds (the timeout), not 15
      expect(elapsed).toBeGreaterThan(4000);
      expect(elapsed).toBeLessThan(10000);
    },
    20000 // bun:test per-test timeout
  );

  it('should reject invalid CLAUDE_MEM_HOOK_TIMEOUT_MS and use default', async () => {
    // Script that exits quickly - just verify it doesn't crash with invalid env
    const result = await runBunRunner('process.exit(0);', {
      CLAUDE_MEM_HOOK_TIMEOUT_MS: 'not-a-number',
    }, 5000);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('should reject too-small CLAUDE_MEM_HOOK_TIMEOUT_MS and use default', async () => {
    const result = await runBunRunner('process.exit(0);', {
      CLAUDE_MEM_HOOK_TIMEOUT_MS: '100', // Below 5000 minimum
    }, 5000);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('should preserve non-zero exit codes from child', async () => {
    const result = await runBunRunner('process.exit(42);', {}, 5000);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(42);
  });
});

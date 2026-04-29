import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { buildStatusOutput, StatusOutput } from '../../src/services/worker-service.js';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');

function runWorkerStart(): { stdout: string; exitCode: number } {
  const result = spawnSync('bun', [WORKER_SCRIPT, 'start'], {
    encoding: 'utf-8',
    timeout: 60000
  });
  return { stdout: result.stdout?.trim() || '', exitCode: result.status || 0 };
}

describe('worker-json-status', () => {
  describe('buildStatusOutput', () => {
    describe('ready status', () => {
      it('should return valid JSON with required fields for ready status', () => {
        const result = buildStatusOutput('ready');

        expect(result.status).toBe('ready');
        expect(result.continue).toBe(true);
        expect(result.suppressOutput).toBe(true);
      });

      it('should not include message field when not provided', () => {
        const result = buildStatusOutput('ready');

        expect(result.message).toBeUndefined();
        expect('message' in result).toBe(false);
      });

      it('should include message field when explicitly provided for ready status', () => {
        const result = buildStatusOutput('ready', 'Worker started successfully');

        expect(result.status).toBe('ready');
        expect(result.message).toBe('Worker started successfully');
      });
    });

    describe('error status', () => {
      it('should return valid JSON with required fields for error status', () => {
        const result = buildStatusOutput('error');

        expect(result.status).toBe('error');
        expect(result.continue).toBe(true);
        expect(result.suppressOutput).toBe(true);
      });

      it('should include message field when provided for error status', () => {
        const result = buildStatusOutput('error', 'Port in use but worker not responding');

        expect(result.status).toBe('error');
        expect(result.message).toBe('Port in use but worker not responding');
      });

      it('should handle various error messages correctly', () => {
        const errorMessages = [
          'Port did not free after version mismatch restart',
          'Failed to spawn worker daemon',
          'Worker failed to start (health check timeout)'
        ];

        for (const msg of errorMessages) {
          const result = buildStatusOutput('error', msg);
          expect(result.message).toBe(msg);
        }
      });
    });

    describe('required fields always present', () => {
      it('should always include continue: true', () => {
        expect(buildStatusOutput('ready').continue).toBe(true);
        expect(buildStatusOutput('error').continue).toBe(true);
        expect(buildStatusOutput('ready', 'msg').continue).toBe(true);
        expect(buildStatusOutput('error', 'msg').continue).toBe(true);
      });

      it('should always include suppressOutput: true', () => {
        expect(buildStatusOutput('ready').suppressOutput).toBe(true);
        expect(buildStatusOutput('error').suppressOutput).toBe(true);
        expect(buildStatusOutput('ready', 'msg').suppressOutput).toBe(true);
        expect(buildStatusOutput('error', 'msg').suppressOutput).toBe(true);
      });
    });

    describe('JSON serialization', () => {
      it('should produce valid JSON when stringified', () => {
        const readyResult = buildStatusOutput('ready');
        const errorResult = buildStatusOutput('error', 'Test error message');

        expect(() => JSON.stringify(readyResult)).not.toThrow();
        expect(() => JSON.stringify(errorResult)).not.toThrow();

        const parsedReady = JSON.parse(JSON.stringify(readyResult));
        expect(parsedReady.status).toBe('ready');
        expect(parsedReady.continue).toBe(true);

        const parsedError = JSON.parse(JSON.stringify(errorResult));
        expect(parsedError.status).toBe('error');
        expect(parsedError.message).toBe('Test error message');
      });

      it('should match expected JSON structure for hook framework', () => {
        const readyOutput = JSON.stringify(buildStatusOutput('ready'));
        const errorOutput = JSON.stringify(buildStatusOutput('error', 'error msg'));

        const parsedReady = JSON.parse(readyOutput);
        expect(parsedReady).toEqual({
          continue: true,
          suppressOutput: true,
          status: 'ready'
        });

        const parsedError = JSON.parse(errorOutput);
        expect(parsedError).toEqual({
          continue: true,
          suppressOutput: true,
          status: 'error',
          message: 'error msg'
        });
      });
    });

    describe('type safety', () => {
      it('should only accept valid status values', () => {
        const readyResult: StatusOutput = buildStatusOutput('ready');
        const errorResult: StatusOutput = buildStatusOutput('error');

        expect(['ready', 'error']).toContain(readyResult.status);
        expect(['ready', 'error']).toContain(errorResult.status);
      });

      it('should have correct type structure', () => {
        const result = buildStatusOutput('ready');

        expect(result.continue).toBe(true as const);
        expect(result.suppressOutput).toBe(true as const);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string message', () => {
        const result = buildStatusOutput('error', '');
        expect('message' in result).toBe(false);
      });

      it('should handle message with special characters', () => {
        const specialMessage = 'Error: "quoted" & special <chars>';
        const result = buildStatusOutput('error', specialMessage);
        expect(result.message).toBe(specialMessage);

        const parsed = JSON.parse(JSON.stringify(result));
        expect(parsed.message).toBe(specialMessage);
      });

      it('should handle very long message', () => {
        const longMessage = 'A'.repeat(10000);
        const result = buildStatusOutput('error', longMessage);
        expect(result.message).toBe(longMessage);
      });
    });
  });

  describe('start command JSON output', () => {
    describe('when worker already healthy', () => {
      it('should output valid JSON with status: ready', () => {
        if (!existsSync(WORKER_SCRIPT)) {
          console.log('Skipping CLI test - worker script not built');
          return;
        }

        const { stdout, exitCode } = runWorkerStart();

        expect(exitCode).toBe(0);

        expect(() => JSON.parse(stdout)).not.toThrow();

        const parsed = JSON.parse(stdout);

        expect(parsed.continue).toBe(true);
        expect(parsed.suppressOutput).toBe(true);
        expect(['ready', 'error']).toContain(parsed.status);
      });

      it('should match expected JSON structure when worker is healthy', () => {
        if (!existsSync(WORKER_SCRIPT)) {
          console.log('Skipping CLI test - worker script not built');
          return;
        }

        const { stdout } = runWorkerStart();
        const parsed = JSON.parse(stdout);

        if (parsed.status === 'ready') {
          expect(parsed.continue).toBe(true);
          expect(parsed.suppressOutput).toBe(true);
        } else if (parsed.status === 'error') {
          expect(typeof parsed.message).toBe('string');
        }
      });
    });

    describe('error scenarios', () => {
      it.skip('should output JSON with status: error when port in use but not responding', () => {
        // Would require: start a non-worker server on the port, then call start
      });

      it.skip('should output JSON with status: error on spawn failure', () => {
        // Would require: mock spawnDaemon to fail
      });

      it.skip('should output JSON with status: error on health check timeout', () => {
        // Would require: start worker that never becomes healthy
      });
    });
  });

  describe('Claude Code hook framework compatibility', () => {
    it('should always exit with code 0', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { exitCode } = runWorkerStart();

      expect(exitCode).toBe(0);
    });

    it('should output JSON on stdout (not stderr)', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const result = spawnSync('bun', [WORKER_SCRIPT, 'start'], {
        encoding: 'utf-8',
        timeout: 60000
      });

      const stdout = result.stdout?.trim() || '';
      const stderr = result.stderr?.trim() || '';

      expect(() => JSON.parse(stdout)).not.toThrow();

      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('continue');

      if (stderr) {
        try {
          const stderrParsed = JSON.parse(stderr);
          expect(stderrParsed).not.toHaveProperty('suppressOutput');
        } catch {
          // stderr is not JSON, which is expected (logs, etc.)
        }
      }
    });

    it('should be parseable as valid JSON', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();

      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(stdout);
      }).not.toThrow();

      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    });

    it('should always include continue: true (required for Claude Code to proceed)', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();
      const parsed = JSON.parse(stdout);

      expect(parsed.continue).toBe(true);

      expect(parsed.continue).toStrictEqual(true);
    });

    it('should include suppressOutput: true to hide from transcript mode', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();
      const parsed = JSON.parse(stdout);

      expect(parsed.suppressOutput).toBe(true);
    });

    it('should include a valid status field', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();
      const parsed = JSON.parse(stdout);

      expect(parsed).toHaveProperty('status');
      expect(['ready', 'error']).toContain(parsed.status);
    });
  });
});

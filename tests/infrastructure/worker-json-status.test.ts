/**
 * Tests for worker JSON status output structure
 *
 * Tests the buildStatusOutput pure function extracted from worker-service.ts
 * to ensure JSON output matches the hook framework contract.
 *
 * No mocks needed - tests a pure function directly.
 */
import { describe, it, expect } from 'bun:test';
import { buildStatusOutput, StatusOutput } from '../../src/services/worker-service.js';

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

        // Verify exact structure (order may vary, but content must match)
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
        // TypeScript ensures these are the only valid values at compile time
        // This runtime test validates the behavior
        const readyResult: StatusOutput = buildStatusOutput('ready');
        const errorResult: StatusOutput = buildStatusOutput('error');

        expect(['ready', 'error']).toContain(readyResult.status);
        expect(['ready', 'error']).toContain(errorResult.status);
      });

      it('should have correct type structure', () => {
        const result = buildStatusOutput('ready');

        // Verify literal types
        expect(result.continue).toBe(true as const);
        expect(result.suppressOutput).toBe(true as const);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string message', () => {
        // Empty string is falsy, so message should NOT be included
        const result = buildStatusOutput('error', '');
        expect('message' in result).toBe(false);
      });

      it('should handle message with special characters', () => {
        const specialMessage = 'Error: "quoted" & special <chars>';
        const result = buildStatusOutput('error', specialMessage);
        expect(result.message).toBe(specialMessage);

        // Verify it serializes correctly
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
});

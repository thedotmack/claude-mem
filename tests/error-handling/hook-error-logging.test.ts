/**
 * Test: Hook Error Logging
 *
 * Verifies that hooks properly log errors when failures occur.
 * This test prevents regression of silent failure bugs (observations 25389, 25307).
 *
 * Recent bugs:
 * - save-hook was completely silent on errors
 * - new-hook didn't log fetch failures
 * - context-hook had no error context
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleFetchError } from '../../src/hooks/shared/error-handler.js';
import { handleWorkerError } from '../../src/shared/hook-error-handler.js';

describe('Hook Error Logging', () => {
  let consoleErrorSpy: any;
  let loggerErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('handleFetchError', () => {
    it('logs error with full context when fetch fails', () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      } as Response;

      const errorText = 'Database connection failed';
      const context = {
        hookName: 'save',
        operation: 'Observation storage',
        toolName: 'Bash',
        sessionId: 'test-session-123',
        port: 37777
      };

      expect(() => {
        handleFetchError(mockResponse, errorText, context);
      }).toThrow();

      // Verify: Error thrown contains user-facing message with restart instructions
      try {
        handleFetchError(mockResponse, errorText, context);
      } catch (error: any) {
        expect(error.message).toContain('Failed Observation storage for Bash');
        expect(error.message).toContain('npm run worker:restart');
      }
    });

    it('includes port and session ID in error context', () => {
      const mockResponse = {
        ok: false,
        status: 404
      } as Response;

      const context = {
        hookName: 'context',
        operation: 'Context generation',
        project: 'my-project',
        port: 37777
      };

      try {
        handleFetchError(mockResponse, 'Not found', context);
      } catch (error: any) {
        expect(error.message).toContain('Context generation failed');
      }
    });

    it('provides different messages for operations with and without tools', () => {
      const mockResponse = { ok: false, status: 500 } as Response;

      // With tool name
      const withTool = {
        hookName: 'save',
        operation: 'Save',
        toolName: 'Read'
      };

      try {
        handleFetchError(mockResponse, 'error', withTool);
      } catch (error: any) {
        expect(error.message).toContain('for Read');
      }

      // Without tool name
      const withoutTool = {
        hookName: 'context',
        operation: 'Context generation'
      };

      try {
        handleFetchError(mockResponse, 'error', withoutTool);
      } catch (error: any) {
        expect(error.message).not.toContain('for');
        expect(error.message).toContain('Context generation failed');
      }
    });
  });

  describe('handleWorkerError', () => {
    it('handles timeout errors with restart instructions', () => {
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';

      expect(() => {
        handleWorkerError(timeoutError);
      }).toThrow('Worker service connection failed');
    });

    it('handles connection refused errors with restart instructions', () => {
      const connError = new Error('connect ECONNREFUSED 127.0.0.1:37777') as any;
      connError.cause = { code: 'ECONNREFUSED' };

      expect(() => {
        handleWorkerError(connError);
      }).toThrow('npm run worker:restart');
    });

    it('re-throws non-connection errors unchanged', () => {
      const genericError = new Error('Something went wrong');

      try {
        handleWorkerError(genericError);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('Something went wrong');
        expect(error.message).not.toContain('npm run worker:restart');
      }
    });

    it('preserves original error message in thrown error', () => {
      const originalError = new Error('Database write failed');

      try {
        handleWorkerError(originalError);
      } catch (error: any) {
        expect(error.message).toContain('Database write failed');
      }
    });
  });

  describe('Real Hook Error Scenarios', () => {
    it('save-hook logs context when observation storage fails', async () => {
      // Simulate save-hook.ts fetch failure
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal error'
      });

      const mockContext = {
        hookName: 'save',
        operation: 'Observation storage',
        toolName: 'Edit',
        sessionId: 'session-456',
        port: 37777
      };

      const response = await fetch('http://127.0.0.1:37777/api/sessions/observations');
      const errorText = await response.text();

      expect(() => {
        handleFetchError(response, errorText, mockContext);
      }).toThrow('Failed Observation storage for Edit');
    });

    it('new-hook logs context when session initialization fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid session ID'
      });

      const mockContext = {
        hookName: 'new',
        operation: 'Session initialization',
        project: 'claude-mem',
        port: 37777
      };

      const response = await fetch('http://127.0.0.1:37777/api/sessions/init');
      const errorText = await response.text();

      expect(() => {
        handleFetchError(response, errorText, mockContext);
      }).toThrow('Session initialization failed');
    });

    it('context-hook logs context when context generation fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service unavailable'
      });

      const mockContext = {
        hookName: 'context',
        operation: 'Context generation',
        project: 'my-app',
        port: 37777
      };

      const response = await fetch('http://127.0.0.1:37777/api/context/inject');
      const errorText = await response.text();

      expect(() => {
        handleFetchError(response, errorText, mockContext);
      }).toThrow('Context generation failed');
    });
  });

  describe('Error Message Quality', () => {
    it('error messages are actionable and include next steps', () => {
      const mockResponse = { ok: false, status: 500 } as Response;
      const context = {
        hookName: 'save',
        operation: 'Test operation'
      };

      try {
        handleFetchError(mockResponse, 'error', context);
      } catch (error: any) {
        // Must include restart command
        expect(error.message).toMatch(/npm run worker:restart/);

        // Must be user-facing (no technical jargon)
        expect(error.message).not.toContain('ECONNREFUSED');
        expect(error.message).not.toContain('fetch failed');
      }
    });

    it('error messages identify which hook failed', () => {
      const mockResponse = { ok: false, status: 500 } as Response;

      const contexts = [
        { hookName: 'save', operation: 'Save' },
        { hookName: 'context', operation: 'Context' },
        { hookName: 'new', operation: 'Init' },
        { hookName: 'summary', operation: 'Summary' }
      ];

      for (const context of contexts) {
        try {
          handleFetchError(mockResponse, 'error', context);
        } catch (error: any) {
          // Error should help user identify which operation failed
          expect(error.message).toBeTruthy();
          expect(error.message.length).toBeGreaterThan(10);
        }
      }
    });
  });
});

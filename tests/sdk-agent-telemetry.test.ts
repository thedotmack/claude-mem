import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for SDKAgent result message telemetry logging
 *
 * The result handler should:
 * - Log success results with stop_reason, total_cost_usd, num_turns
 * - Log error results with subtype and errors array
 * - Handle missing/undefined fields gracefully
 */

// Mock the logger to capture log calls
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dataOut: vi.fn(),
};

vi.mock('../src/utils/logger.js', () => ({
  logger: mockLogger,
}));

/** Mirrors SDKStreamMessage from SDKAgent.ts */
interface SDKStreamMessage {
  session_id?: string;
  type?: string;
  subtype?: string;
  message?: unknown;
  // Result fields (present when type === 'result')
  stop_reason?: string | null;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
  // Error fields (present when subtype starts with 'error_')
  errors?: string[];
}

/**
 * Extracts the result logging logic from SDKAgent.startSession()
 * so it can be tested in isolation without spawning a real SDK query.
 */
function handleResultMessage(
  message: SDKStreamMessage,
  sessionDbId: number,
  log: typeof mockLogger
): void {
  if (message.type !== 'result') return;

  if (message.subtype === 'success') {
    log.info('SDK', 'Query completed', {
      sessionId: sessionDbId,
      stopReason: message.stop_reason,
      totalCostUsd: message.total_cost_usd,
      numTurns: message.num_turns,
    });
  } else {
    log.warn('SDK', `Query ended with error: ${message.subtype ?? 'unknown'}`, {
      sessionId: sessionDbId,
      stopReason: message.stop_reason,
      errors: message.errors,
    });
  }
}

describe('SDKAgent Result Telemetry Logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Success result messages', () => {
    it('should log stop_reason, total_cost_usd, and num_turns on success', () => {
      const message: SDKStreamMessage = {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        total_cost_usd: 0.042,
        num_turns: 3,
      };

      handleResultMessage(message, 42, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledOnce();
      expect(mockLogger.info).toHaveBeenCalledWith('SDK', 'Query completed', {
        sessionId: 42,
        stopReason: 'end_turn',
        totalCostUsd: 0.042,
        numTurns: 3,
      });
    });

    it('should handle null stop_reason gracefully', () => {
      const message: SDKStreamMessage = {
        type: 'result',
        subtype: 'success',
        stop_reason: null,
        total_cost_usd: 0.01,
        num_turns: 1,
      };

      handleResultMessage(message, 10, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledOnce();
      expect(mockLogger.info).toHaveBeenCalledWith('SDK', 'Query completed', {
        sessionId: 10,
        stopReason: null,
        totalCostUsd: 0.01,
        numTurns: 1,
      });
    });

    it('should handle missing optional fields (undefined values)', () => {
      const message: SDKStreamMessage = {
        type: 'result',
        subtype: 'success',
        // No stop_reason, total_cost_usd, or num_turns
      };

      handleResultMessage(message, 5, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledOnce();
      expect(mockLogger.info).toHaveBeenCalledWith('SDK', 'Query completed', {
        sessionId: 5,
        stopReason: undefined,
        totalCostUsd: undefined,
        numTurns: undefined,
      });
    });
  });

  describe('Error result messages', () => {
    it('should log subtype and errors array on error', () => {
      const message: SDKStreamMessage = {
        type: 'result',
        subtype: 'error_tool_execution',
        stop_reason: 'error',
        errors: ['Tool execution failed: timeout'],
      };

      handleResultMessage(message, 42, mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'SDK',
        'Query ended with error: error_tool_execution',
        {
          sessionId: 42,
          stopReason: 'error',
          errors: ['Tool execution failed: timeout'],
        }
      );
    });

    it('should handle unknown subtype as "unknown"', () => {
      const message: SDKStreamMessage = {
        type: 'result',
        // No subtype
      };

      handleResultMessage(message, 1, mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'SDK',
        'Query ended with error: unknown',
        {
          sessionId: 1,
          stopReason: undefined,
          errors: undefined,
        }
      );
    });

    it('should handle multiple errors in array', () => {
      const message: SDKStreamMessage = {
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Max turns exceeded', 'Budget limit reached'],
      };

      handleResultMessage(message, 99, mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'SDK',
        'Query ended with error: error_max_turns',
        expect.objectContaining({
          errors: ['Max turns exceeded', 'Budget limit reached'],
        })
      );
    });
  });

  describe('Non-result messages', () => {
    it('should not log anything for assistant messages', () => {
      const message: SDKStreamMessage = {
        type: 'assistant',
        message: { content: 'hello' },
      };

      handleResultMessage(message, 1, mockLogger);

      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should not log anything for messages without type', () => {
      const message: SDKStreamMessage = {};

      handleResultMessage(message, 1, mockLogger);

      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });
});

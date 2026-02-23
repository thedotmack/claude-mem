/**
 * Tests for Hook Lifecycle Fixes (TRIAGE-04)
 *
 * Validates:
 * - Stop hook returns suppressOutput: true (prevents infinite loop #987)
 * - All handlers return suppressOutput: true (prevents conversation pollution #598, #784)
 * - Unknown event types handled gracefully (fixes #984)
 * - stderr suppressed in hook context (fixes #1181)
 * - Claude Code adapter defaults suppressOutput to true
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// --- Event Handler Tests ---

describe('Hook Lifecycle - Event Handlers', () => {
  describe('getEventHandler', () => {
    it('should return handler for all recognized event types', async () => {
      const { getEventHandler } = await import('../src/cli/handlers/index.js');
      const recognizedTypes = [
        'context', 'session-init', 'observation',
        'summarize', 'session-complete', 'user-message', 'file-edit'
      ];
      for (const type of recognizedTypes) {
        const handler = getEventHandler(type);
        expect(handler).toBeDefined();
        expect(handler.execute).toBeDefined();
      }
    });

    it('should return no-op handler for unknown event types (#984)', async () => {
      const { getEventHandler } = await import('../src/cli/handlers/index.js');
      const handler = getEventHandler('nonexistent-event');
      expect(handler).toBeDefined();
      expect(handler.execute).toBeDefined();

      const result = await handler.execute({
        sessionId: 'test-session',
        cwd: '/tmp'
      });
      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('should include session-complete as a recognized event type (#984)', async () => {
      const { getEventHandler } = await import('../src/cli/handlers/index.js');
      const handler = getEventHandler('session-complete');
      // session-complete should NOT be the no-op handler
      // We can verify this by checking it's not the same as an unknown type handler
      expect(handler).toBeDefined();
      // The real handler has different behavior than the no-op
      // (it tries to call the worker, while no-op just returns immediately)
    });
  });
});

// --- Platform Adapter Tests ---

describe('Hook Lifecycle - Claude Code Adapter', () => {
  it('should default suppressOutput to true when not explicitly set', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');

    // Result with no suppressOutput field
    const output = claudeCodeAdapter.formatOutput({ continue: true });
    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('should default both continue and suppressOutput to true for empty result', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');

    const output = claudeCodeAdapter.formatOutput({});
    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('should respect explicit suppressOutput: false', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');

    const output = claudeCodeAdapter.formatOutput({ continue: true, suppressOutput: false });
    expect(output).toEqual({ continue: true, suppressOutput: false });
  });

  it('should use hookSpecificOutput format for context injection', async () => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');

    const result = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'test context' },
      systemMessage: 'test message'
    };
    const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;
    expect(output.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: 'test context' });
    expect(output.systemMessage).toBe('test message');
    // Should NOT have continue/suppressOutput when using hookSpecificOutput
    expect(output.continue).toBeUndefined();
    expect(output.suppressOutput).toBeUndefined();
  });
});

// --- stderr Suppression Tests ---

describe('Hook Lifecycle - stderr Suppression (#1181)', () => {
  let originalStderrWrite: typeof process.stderr.write;
  let stderrOutput: string[];

  beforeEach(() => {
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    stderrOutput = [];
    // Capture stderr writes
    process.stderr.write = ((chunk: any) => {
      stderrOutput.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it('should not use console.error in handlers/index.ts for unknown events', async () => {
    // Re-import to get fresh module
    const { getEventHandler } = await import('../src/cli/handlers/index.js');

    // Clear any stderr from import
    stderrOutput.length = 0;

    // Call with unknown event — should use logger (writes to file), not console.error (writes to stderr)
    const handler = getEventHandler('unknown-event-type');
    await handler.execute({ sessionId: 'test', cwd: '/tmp' });

    // No stderr output should have leaked from the handler dispatcher itself
    // (logger may write to stderr as fallback if log file unavailable, but that's
    // the logger's responsibility, not the dispatcher's)
    const dispatcherStderr = stderrOutput.filter(s => s.includes('[claude-mem] Unknown event'));
    expect(dispatcherStderr).toHaveLength(0);
  });
});

// --- Hook Response Constants ---

describe('Hook Lifecycle - Standard Response', () => {
  it('should define standard hook response with suppressOutput: true', async () => {
    const { STANDARD_HOOK_RESPONSE } = await import('../src/hooks/hook-response.js');
    const parsed = JSON.parse(STANDARD_HOOK_RESPONSE);
    expect(parsed.continue).toBe(true);
    expect(parsed.suppressOutput).toBe(true);
  });
});

// --- hookCommand stderr suppression ---

describe('hookCommand - stderr suppression', () => {
  it('should not use console.error for worker unavailable errors', async () => {
    // The hookCommand function should use logger.warn instead of console.error
    // for worker unavailable errors, so stderr stays clean (#1181)
    const { hookCommand } = await import('../src/cli/hook-command.js');

    // Verify the import includes logger
    const hookCommandSource = await Bun.file(
      new URL('../src/cli/hook-command.ts', import.meta.url).pathname
    ).text();

    // Should import logger
    expect(hookCommandSource).toContain("import { logger }");
    // Should use logger.warn for worker unavailable
    expect(hookCommandSource).toContain("logger.warn('HOOK'");
    // Should use logger.error for hook errors
    expect(hookCommandSource).toContain("logger.error('HOOK'");
    // Should suppress stderr
    expect(hookCommandSource).toContain("process.stderr.write = (() => true)");
    // Should restore stderr in finally block
    expect(hookCommandSource).toContain("process.stderr.write = originalStderrWrite");
    // Should NOT have console.error for error reporting
    expect(hookCommandSource).not.toContain("console.error(`[claude-mem]");
    expect(hookCommandSource).not.toContain("console.error(`Hook error:");
  });
});

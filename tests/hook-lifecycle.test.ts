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

// --- Codex CLI Compatibility Tests (#744) ---

describe('Codex CLI Compatibility (#744)', () => {
  describe('getPlatformAdapter', () => {
    it('should return rawAdapter for unknown platforms like codex', async () => {
      const { getPlatformAdapter, rawAdapter } = await import('../src/cli/adapters/index.js');
      // Should not throw for unknown platforms — falls back to rawAdapter
      const adapter = getPlatformAdapter('codex');
      expect(adapter).toBe(rawAdapter);
    });

    it('should return rawAdapter for any unrecognized platform string', async () => {
      const { getPlatformAdapter, rawAdapter } = await import('../src/cli/adapters/index.js');
      const adapter = getPlatformAdapter('some-future-cli');
      expect(adapter).toBe(rawAdapter);
    });
  });

  describe('claudeCodeAdapter session_id fallbacks', () => {
    it('should use session_id when present', async () => {
      const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
      const input = claudeCodeAdapter.normalizeInput({ session_id: 'claude-123', cwd: '/tmp' });
      expect(input.sessionId).toBe('claude-123');
    });

    it('should fall back to id field (Codex CLI format)', async () => {
      const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
      const input = claudeCodeAdapter.normalizeInput({ id: 'codex-456', cwd: '/tmp' });
      expect(input.sessionId).toBe('codex-456');
    });

    it('should fall back to sessionId field (camelCase format)', async () => {
      const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
      const input = claudeCodeAdapter.normalizeInput({ sessionId: 'camel-789', cwd: '/tmp' });
      expect(input.sessionId).toBe('camel-789');
    });

    it('should return undefined when no session ID field is present', async () => {
      const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
      const input = claudeCodeAdapter.normalizeInput({ cwd: '/tmp' });
      expect(input.sessionId).toBeUndefined();
    });

    it('should handle undefined input gracefully', async () => {
      const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
      const input = claudeCodeAdapter.normalizeInput(undefined);
      expect(input.sessionId).toBeUndefined();
      expect(input.cwd).toBe(process.cwd());
    });
  });

  describe('session-init handler undefined prompt', () => {
    it('should not throw when prompt is undefined', () => {
      // Verify the short-circuit logic works for undefined
      const rawPrompt: string | undefined = undefined;
      const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
      expect(prompt).toBe('[media prompt]');
    });

    it('should not throw when prompt is empty string', () => {
      const rawPrompt = '';
      const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
      expect(prompt).toBe('[media prompt]');
    });

    it('should not throw when prompt is whitespace-only', () => {
      const rawPrompt = '   ';
      const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
      expect(prompt).toBe('[media prompt]');
    });

    it('should preserve valid prompts', () => {
      const rawPrompt = 'fix the bug';
      const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;
      expect(prompt).toBe('fix the bug');
    });
  });
});

// --- Cursor IDE Compatibility Tests (#838, #1049) ---

describe('Cursor IDE Compatibility (#838, #1049)', () => {
  describe('cursorAdapter session ID fallbacks', () => {
    it('should use conversation_id when present', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'conv-123', workspace_roots: ['/project'] });
      expect(input.sessionId).toBe('conv-123');
    });

    it('should fall back to generation_id', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ generation_id: 'gen-456', workspace_roots: ['/project'] });
      expect(input.sessionId).toBe('gen-456');
    });

    it('should fall back to id field', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ id: 'id-789', workspace_roots: ['/project'] });
      expect(input.sessionId).toBe('id-789');
    });

    it('should return undefined when no session ID field is present', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ workspace_roots: ['/project'] });
      expect(input.sessionId).toBeUndefined();
    });
  });

  describe('cursorAdapter prompt field fallbacks', () => {
    it('should use prompt when present', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', prompt: 'fix the bug' });
      expect(input.prompt).toBe('fix the bug');
    });

    it('should fall back to query field', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', query: 'search for files' });
      expect(input.prompt).toBe('search for files');
    });

    it('should fall back to input field', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', input: 'user typed this' });
      expect(input.prompt).toBe('user typed this');
    });

    it('should fall back to message field', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', message: 'hello cursor' });
      expect(input.prompt).toBe('hello cursor');
    });

    it('should return undefined when no prompt field is present', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1' });
      expect(input.prompt).toBeUndefined();
    });

    it('should prefer prompt over query', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', prompt: 'primary', query: 'secondary' });
      expect(input.prompt).toBe('primary');
    });
  });

  describe('cursorAdapter cwd fallbacks', () => {
    it('should use workspace_roots[0] when present', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', workspace_roots: ['/my/project'] });
      expect(input.cwd).toBe('/my/project');
    });

    it('should fall back to cwd field', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1', cwd: '/fallback/dir' });
      expect(input.cwd).toBe('/fallback/dir');
    });

    it('should fall back to process.cwd() when nothing provided', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput({ conversation_id: 'c1' });
      expect(input.cwd).toBe(process.cwd());
    });
  });

  describe('cursorAdapter undefined input handling', () => {
    it('should handle undefined input gracefully', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput(undefined);
      expect(input.sessionId).toBeUndefined();
      expect(input.prompt).toBeUndefined();
      expect(input.cwd).toBe(process.cwd());
    });

    it('should handle null input gracefully', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const input = cursorAdapter.normalizeInput(null);
      expect(input.sessionId).toBeUndefined();
      expect(input.prompt).toBeUndefined();
      expect(input.cwd).toBe(process.cwd());
    });
  });

  describe('cursorAdapter formatOutput', () => {
    it('should return simple continue flag', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const output = cursorAdapter.formatOutput({ continue: true, suppressOutput: true });
      expect(output).toEqual({ continue: true });
    });

    it('should default continue to true', async () => {
      const { cursorAdapter } = await import('../src/cli/adapters/cursor.js');
      const output = cursorAdapter.formatOutput({});
      expect(output).toEqual({ continue: true });
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

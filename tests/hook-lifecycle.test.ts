import { describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Hook Lifecycle - Event Handlers', () => {
  describe('getEventHandler', () => {
    it('returns the registered handler for every recognized event type', async () => {
      const h = await import('../src/cli/handlers/index.js');
      const expected = {
        context: h.contextHandler,
        'session-init': h.sessionInitWithAntigravityTurnsHandler,
        'session-init-context': h.sessionInitContextHandler,
        observation: h.observationWithPendingTimelineHandler,
        summarize: h.summarizeHandler,
        'session-end': h.sessionEndHandler,
        'subagent-stop': h.subagentStopHandler,
        'user-message': h.userMessageHandler,
        'file-edit': h.fileEditHandler,
        'file-context': h.fileContextHandler,
        'post-compact': h.postCompactHandler,
        'subagent-context': h.subagentContextHandler,
      };
      for (const [type, handler] of Object.entries(expected)) {
        expect(h.getEventHandler(type)).toBe(handler);
      }
    });

    it('should return no-op handler for unknown event types (#984)', async () => {
      const { getEventHandler } = await import('../src/cli/handlers/index.js');
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const handler = getEventHandler('nonexistent-event');
        expect(await handler.execute({ sessionId: 'test-session', cwd: process.cwd() }))
          .toEqual({ continue: true, suppressOutput: true, exitCode: 0 });
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

  });
});

describe('Codex CLI Compatibility (#744)', () => {
  describe('getPlatformAdapter', () => {
    it('should return codexAdapter for codex', async () => {
      const { getPlatformAdapter, codexAdapter } = await import('../src/cli/adapters/index.js');
      const adapter = getPlatformAdapter('codex');
      expect(adapter).toBe(codexAdapter);
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

  describe('codexAdapter', () => {
    it('normalizes snake_case Stop payloads with last assistant message', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const input = codexAdapter.normalizeInput({
        hook_event_name: 'Stop',
        session_id: 'codex-session',
        turn_id: 'turn-1',
        cwd: '/tmp',
        stop_hook_active: false,
        last_assistant_message: 'done',
      });

      expect(input.sessionId).toBe('codex-session');
      expect(input.turnId).toBe('turn-1');
      expect(input.lastAssistantMessage).toBe('done');
      expect(input.stopHookActive).toBe(false);
    });

    it('normalizes string stop_hook_active payloads', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const active = codexAdapter.normalizeInput({
        hook_event_name: 'Stop',
        session_id: 'codex-session',
        cwd: '/tmp',
        stop_hook_active: 'true',
      });
      const inactive = codexAdapter.normalizeInput({
        hook_event_name: 'Stop',
        session_id: 'codex-session',
        cwd: '/tmp',
        stop_hook_active: 'false',
      });

      expect(active.stopHookActive).toBe(true);
      expect(inactive.stopHookActive).toBe(false);
    });

    it('rejects payloads without a session_id', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const { AdapterRejectedInput } = await import('../src/cli/adapters/errors.js');

      expect(() => codexAdapter.normalizeInput({
        hook_event_name: 'Stop',
        cwd: '/tmp',
      })).toThrow(AdapterRejectedInput);
    });

    it('adds filePaths without dropping the original object tool input', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const tmpDir = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
      try {
        writeFileSync(join(tmpDir, 'README.md'), 'readme');

        const input = codexAdapter.normalizeInput({
          hook_event_name: 'PreToolUse',
          session_id: 'codex-session',
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'cat README.md' },
        });

        expect(input.toolInput).toEqual({
          command: 'cat README.md',
          filePaths: ['README.md'],
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('preserves non-object tool input payloads', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const input = codexAdapter.normalizeInput({
        hook_event_name: 'PreToolUse',
        session_id: 'codex-session',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: 'cat README.md',
      });

      expect(input.toolInput).toBe('cat README.md');
    });

    it('drops PreToolUse allow decisions because Codex only accepts deny', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const output = codexAdapter.formatOutput({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: 'file history',
          permissionDecision: 'allow',
        },
      }) as any;

      expect(output.hookSpecificOutput).toEqual({
        hookEventName: 'PreToolUse',
        additionalContext: 'file history',
      });
    });

    it('omits suppressOutput from base Codex output', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const output = codexAdapter.formatOutput({
        continue: true,
        suppressOutput: true,
      }) as any;

      expect(output).toEqual({ continue: true });
      expect(output).not.toHaveProperty('suppressOutput');
    });

    it('does not emit hookSpecificOutput for Stop outputs', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const output = codexAdapter.formatOutput({
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: 'ignored',
        },
      }) as any;

      expect(output).toEqual({ continue: true });
    });

    it('preserves an explicit empty-string additionalContext instead of dropping the key (#3127)', async () => {
      const { codexAdapter } = await import('../src/cli/adapters/codex.js');
      const output = codexAdapter.formatOutput({
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      }) as any;

      expect(output).toEqual({
        continue: true,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      });
    });
  });
});

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

describe('Hook Lifecycle - Claude Code Adapter', () => {
  const fmt = async (input: any) => {
    const { claudeCodeAdapter } = await import('../src/cli/adapters/claude-code.js');
    return claudeCodeAdapter.formatOutput(input);
  };

  it('should return empty object for empty result', async () => {
    expect(await fmt({})).toEqual({});
  });

  it('should include systemMessage when present', async () => {
    expect(await fmt({ systemMessage: 'test message' })).toEqual({ systemMessage: 'test message' });
  });

  it('should use hookSpecificOutput format with systemMessage', async () => {
    const output = await fmt({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'test context' },
      systemMessage: 'test message'
    }) as Record<string, unknown>;
    expect(output.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: 'test context' });
    expect(output.systemMessage).toBe('test message');
  });

  it('should return hookSpecificOutput without systemMessage when absent', async () => {
    expect(await fmt({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    })).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    });
  });

  it('should return empty object for malformed input (undefined/null)', async () => {
    expect(await fmt(undefined)).toEqual({});
    expect(await fmt(null)).toEqual({});
  });

  it('should exclude falsy systemMessage values', async () => {
    expect(await fmt({ systemMessage: '' })).toEqual({});
    expect(await fmt({ systemMessage: null })).toEqual({});
    expect(await fmt({ systemMessage: 0 })).toEqual({});
  });

  it('should strip all non-contract fields', async () => {
    expect(await fmt({
      continue: false,
      suppressOutput: false,
      systemMessage: 'msg',
      exitCode: 2,
      hookSpecificOutput: undefined,
    })).toEqual({ systemMessage: 'msg' });
  });

});

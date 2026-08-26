import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { antigravityCliAdapter } from '../src/cli/adapters/antigravity-cli.js';

const INSTALLER_PATH = 'src/services/integrations/AntigravityCliHooksInstaller.ts';

describe('AntigravityCliHooksInstaller - event mapping (B0-confirmed 7-event map)', () => {
  const src = readFileSync(INSTALLER_PATH, 'utf-8');

  it('maps SessionStart to context', () => {
    expect(src).toContain("'SessionStart': 'context'");
  });

  it('maps BeforeAgent to session-init, not user-message', () => {
    expect(src).toContain("'BeforeAgent': 'session-init'");
  });

  it('maps AfterAgent, BeforeTool, AfterTool, and Notification to observation', () => {
    expect(src).toContain("'AfterAgent': 'observation'");
    expect(src).toContain("'BeforeTool': 'observation'");
    expect(src).toContain("'AfterTool': 'observation'");
    expect(src).toContain("'Notification': 'observation'");
  });

  it('maps PreCompress to summarize', () => {
    expect(src).toContain("'PreCompress': 'summarize'");
  });

  it('should not map SessionEnd (session-complete has no handler; worker self-completes)', () => {
    expect(src).not.toContain("'SessionEnd':");
  });

  it('uses the antigravity-cli hook command string, not gemini-cli', () => {
    expect(src).toContain('hook antigravity-cli');
    expect(src).not.toContain('hook gemini-cli');
  });

  it('targets the shared ~/.gemini config tree (settings.json + GEMINI.md), not a separate Antigravity-only file', () => {
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'settings.json')");
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'GEMINI.md')");
  });

  it('dual-writes MCP config to both B0-confirmed candidate paths', () => {
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'antigravity', 'mcp_config.json')");
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'config', 'mcp_config.json')");
  });

  it('reuses writeMcpJsonConfig from McpIntegrations.ts rather than reimplementing MCP config writing', () => {
    expect(src).toContain("from './McpIntegrations.js'");
    expect(src).toContain('writeMcpJsonConfig');
  });

  it('writes the rules/context placeholder to the plural, home-relative .agents/rules path', () => {
    expect(src).toContain("path.join(homedir(), '.agents', 'rules', 'claude-mem-context.md')");
  });
});

describe('antigravityCliAdapter - normalizeInput', () => {
  it('falls back to process.cwd() when no cwd and no GEMINI_*/CLAUDE_PROJECT_DIR env vars are set', () => {
    const savedCwd = process.env.GEMINI_CWD;
    const savedProjectDir = process.env.GEMINI_PROJECT_DIR;
    const savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.GEMINI_CWD;
    delete process.env.GEMINI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const result = antigravityCliAdapter.normalizeInput({});
      expect(result.cwd).toBe(process.cwd());
    } finally {
      if (savedCwd !== undefined) process.env.GEMINI_CWD = savedCwd;
      if (savedProjectDir !== undefined) process.env.GEMINI_PROJECT_DIR = savedProjectDir;
      if (savedClaudeDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
    }
  });

  it('prefers an explicit cwd over workspacePaths and any env var fallback', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp/explicit-cwd',
      workspacePaths: ['/tmp/workspace-dir'],
    });
    expect(result.cwd).toBe('/tmp/explicit-cwd');
  });

  it('resolves cwd from workspacePaths array when cwd is omitted', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp/from-workspace-paths', '/tmp/secondary-path'],
    });
    expect(result.cwd).toBe('/tmp/from-workspace-paths');
  });

  it('rejects an invalid (empty) cwd', () => {
    expect(() => antigravityCliAdapter.normalizeInput({ cwd: '' })).toThrow('adapter rejected input: invalid_cwd');
  });

  it('prefers explicit session_id over conversationId', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      session_id: 'explicit-session-123',
      conversationId: 'conversation-456',
    });
    expect(result.sessionId).toBe('explicit-session-123');
  });

  it('resolves sessionId from conversationId when session_id is omitted', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      conversationId: 'conversation-456',
    });
    expect(result.sessionId).toBe('conversation-456');
  });

  it('prefers explicit tool_name and tool_input over toolCall object', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'ExplicitTool',
      tool_input: { explicit: true },
      toolCall: { name: 'NestedTool', args: { nested: true } },
    });
    expect(result.toolName).toBe('ExplicitTool');
    expect(result.toolInput).toEqual({ explicit: true });
  });

  it('maps nested toolCall.name and toolCall.args when tool_name/tool_input are omitted', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      toolCall: { name: 'view_file', args: { path: '/tmp/test.ts' } },
    });
    expect(result.toolName).toBe('view_file');
    expect(result.toolInput).toEqual({ path: '/tmp/test.ts' });
  });

  it('prefers tool_response over error and output', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'test_tool',
      tool_response: 'explicit response',
      error: 'error message',
      output: 'output message',
    });
    expect(result.toolResponse).toBe('explicit response');
  });

  it('falls back tool_response to error or output', () => {
    const errorResult = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'test_tool',
      error: 'permission denied',
    });
    expect(errorResult.toolResponse).toBe('permission denied');

    const outputResult = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'test_tool',
      output: 'success output',
    });
    expect(outputResult.toolResponse).toBe('success output');
  });

  it('supplies default toolResponse when toolName is present but no response/output is provided', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'run_command',
      stepIdx: 42,
    });
    expect(result.toolResponse).toEqual({ status: 'completed', stepIdx: 42 });
  });

  it('preserves falsy tool responses such as empty string, 0, and false', () => {
    const emptyStringResult = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'test_tool',
      tool_response: '',
      stepIdx: 1,
    });
    expect(emptyStringResult.toolResponse).toBe('');

    const zeroResult = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'test_tool',
      tool_response: 0,
      stepIdx: 2,
    });
    expect(zeroResult.toolResponse).toBe(0);

    const falseResult = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      tool_name: 'test_tool',
      tool_response: false,
      stepIdx: 3,
    });
    expect(falseResult.toolResponse).toBe(false);
  });

  it('resolves transcriptPath from camelCase transcriptPath or snake_case transcript_path', () => {
    const camel = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      transcriptPath: '/tmp/transcript.jsonl',
    });
    expect(camel.transcriptPath).toBe('/tmp/transcript.jsonl');

    const snake = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      transcript_path: '/tmp/snake_transcript.jsonl',
    });
    expect(snake.transcriptPath).toBe('/tmp/snake_transcript.jsonl');
  });

  it('maps AfterAgent prompt_response into toolName/toolInput/toolResponse', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      hook_event_name: 'AfterAgent',
      prompt: 'hi',
      prompt_response: 'hello there',
    });
    expect(result.toolName).toBe('AntigravityProvider');
    expect(result.toolInput).toEqual({ prompt: 'hi' });
    expect(result.toolResponse).toEqual({ response: 'hello there' });
  });

  it('marks a BeforeTool or PreToolUse call as pre-execution when no response is present', () => {
    const beforeTool = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      hook_event_name: 'BeforeTool',
      tool_name: 'Read',
    });
    expect(beforeTool.toolResponse).toEqual({ _preExecution: true });

    const preToolUse = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    });
    expect(preToolUse.toolResponse).toEqual({ _preExecution: true });
  });

  it('preserves explicit falsy tool responses under BeforeTool and PreToolUse', () => {
    for (const hook of ['BeforeTool', 'PreToolUse']) {
      for (const val of ['', 0, false]) {
        const res = antigravityCliAdapter.normalizeInput({
          cwd: '/tmp',
          hook_event_name: hook,
          tool_name: 'Read',
          tool_response: val,
        });
        expect(res.toolResponse).toBe(val);
      }
    }
  });

  it('maps Notification fields into toolName/toolInput/toolResponse', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      hook_event_name: 'Notification',
      notification_type: 'permission',
      message: 'allow?',
      details: { foo: 'bar' },
    });
    expect(result.toolName).toBe('AntigravityNotification');
    expect(result.toolInput).toEqual({ notification_type: 'permission', message: 'allow?' });
    expect(result.toolResponse).toEqual({ details: { foo: 'bar' } });
  });
});

describe('antigravityCliAdapter - formatOutput', () => {
  it('sets decision to allow and defaults continue to true', () => {
    const result = antigravityCliAdapter.formatOutput({}) as Record<string, unknown>;
    expect(result.decision).toBe('allow');
    expect(result.continue).toBe(true);
  });

  it('sets decision to deny when continue is false', () => {
    const result = antigravityCliAdapter.formatOutput({ continue: false }) as Record<string, unknown>;
    expect(result.decision).toBe('deny');
    expect(result.continue).toBe(false);
  });

  it('strips ANSI escape codes and sets injectSteps for ephemeral context messaging', () => {
    const raw = '\u001b[31mRed context text\u001b[0m';
    const result = antigravityCliAdapter.formatOutput({ systemMessage: raw }) as Record<string, unknown>;
    expect(result.systemMessage).toBe('Red context text');
    expect(result.injectSteps).toEqual([{ ephemeralMessage: 'Red context text' }]);
  });

  it('extracts systemMessage from hookSpecificOutput.additionalContext when systemMessage is omitted', () => {
    const result = antigravityCliAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Context from hook' },
    }) as Record<string, unknown>;
    expect(result.systemMessage).toBe('Context from hook');
    expect(result.injectSteps).toEqual([{ ephemeralMessage: 'Context from hook' }]);
    expect(result.hookSpecificOutput).toEqual({ additionalContext: 'Context from hook' });
  });

  it('passes through suppressOutput when explicitly set', () => {
    const result = antigravityCliAdapter.formatOutput({ suppressOutput: true }) as Record<string, unknown>;
    expect(result.suppressOutput).toBe(true);
  });
});

// NOTE: an automated regression test for the B0 empty-mcp-config-file edge
// case (see AntigravityCliHooksInstaller.ts's seedEmptyMcpConfigFile /
// readMcpConfigTolerantly) was deliberately NOT added here. Bun's homedir()
// does not re-read a runtime-reassigned process.env.HOME within a single
// process, so a test attempting to redirect GEMINI_CONFIG_DIR that way
// silently operates on the REAL ~/.gemini instead of an isolated temp dir.
// That was verified by hand (as a one-off script run in a separate process
// with HOME set before start, which bun DOES respect) rather than as a
// committed test, specifically to avoid this footgun running unattended in
// CI/local `bun test` and mutating a real, live ~/.gemini tree every run.

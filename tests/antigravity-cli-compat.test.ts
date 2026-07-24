import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { antigravityCliAdapter } from '../src/cli/adapters/antigravity-cli.js';

const INSTALLER_PATH = 'src/services/integrations/AntigravityCliHooksInstaller.ts';

describe('AntigravityCliHooksInstaller - event mapping (official 5-event hooks.json schema)', () => {
  const src = readFileSync(INSTALLER_PATH, 'utf-8');

  it('maps PreInvocation to context', () => {
    expect(src).toContain("'PreInvocation': 'context'");
  });

  it('maps PreToolUse, PostToolUse, and PostInvocation to observation', () => {
    expect(src).toContain("'PreToolUse': 'observation'");
    expect(src).toContain("'PostToolUse': 'observation'");
    expect(src).toContain("'PostInvocation': 'observation'");
  });

  it('maps Stop to summarize', () => {
    expect(src).toContain("'Stop': 'summarize'");
  });

  it('uses the antigravity-cli hook command string, not gemini-cli', () => {
    expect(src).toContain('hook antigravity-cli');
    expect(src).not.toContain('hook gemini-cli');
  });

  it('writes hooks to ~/.gemini/config/hooks.json (agy does not read hooks from settings.json)', () => {
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'config', 'hooks.json')");
    expect(src).not.toContain('mergeHooksIntoSettings');
  });

  it('wraps only tool events in matcher groups; invocation/Stop events use bare entries', () => {
    expect(src).toContain("new Set(['PreToolUse', 'PostToolUse'])");
  });

  it('emits bare forward-slashed hook paths (agy does not strip quotes; quoted paths break every hook)', () => {
    expect(src).toContain('${formattedWorkerPath} hook antigravity-cli ${internalEvent}');
    expect(src).not.toContain('"${formattedWorkerPath}"');
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

describe('antigravityCliAdapter - normalizeInput (flat payload, no event-name field)', () => {
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

  it('prefers workspacePaths[0] over an explicit cwd', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp/workspace'],
      cwd: '/tmp/explicit-cwd',
    });
    expect(result.cwd).toBe('/tmp/workspace');
  });

  it('rejects an invalid (empty) cwd', () => {
    expect(() => antigravityCliAdapter.normalizeInput({ cwd: '' })).toThrow('adapter rejected input: invalid_cwd');
  });

  it('maps a flat PostInvocation payload using the latest transcript prompt and response', () => {
    const transcriptDir = mkdtempSync(join(tmpdir(), 'claude-mem-antigravity-'));
    try {
      const transcriptPath = join(transcriptDir, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        [
          { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'older prompt' },
          { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'older response' },
          { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'latest prompt' },
          { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'latest response' },
          { step_index: 4, source: 'MODEL', type: 'RUN_COMMAND', content: 'not the assistant response' },
        ].map(node => JSON.stringify(node)).join('\n'),
      );

      const result = antigravityCliAdapter.normalizeInput({
        conversationId: 'conversation-123',
        workspacePaths: ['/tmp/workspace'],
        transcriptPath,
        invocationNum: 2,
        initialNumSteps: 1,
      });

      expect(result.sessionId).toBe('conversation-123');
      expect(result.cwd).toBe('/tmp/workspace');
      expect(result.prompt).toBe('latest prompt');
      expect(result.toolName).toBe('AntigravityProvider');
      expect(result.toolInput).toEqual({ prompt: 'latest prompt' });
      expect(result.toolResponse).toEqual({ response: 'latest response' });
    } finally {
      rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('strips agy wrapper tags, keeping only the <USER_REQUEST> content', () => {
    const transcriptDir = mkdtempSync(join(tmpdir(), 'claude-mem-antigravity-'));
    try {
      const transcriptPath = join(transcriptDir, 'transcript.jsonl');
      const wrapped =
        '<USER_REQUEST>\nhi\n</USER_REQUEST>\n' +
        '<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-24T19:46:01+08:00.\n</ADDITIONAL_METADATA>\n' +
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection`.\n</USER_SETTINGS_CHANGE>';
      writeFileSync(
        transcriptPath,
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: wrapped }),
      );

      const result = antigravityCliAdapter.normalizeInput({
        conversationId: 'conversation-xyz',
        workspacePaths: ['/tmp/workspace'],
        transcriptPath,
        invocationNum: 1,
        initialNumSteps: 1,
      });

      expect(result.prompt).toBe('hi');
      expect(result.toolInput).toEqual({ prompt: 'hi' });
    } finally {
      rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('detects a flat PreToolUse payload by the absence of the error key', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      toolCall: { name: 'Read', args: { path: '/tmp/file.txt' } },
    });

    expect(result.toolName).toBe('Read');
    expect(result.toolInput).toEqual({ path: '/tmp/file.txt' });
    expect(result.toolResponse).toEqual({ _preExecution: true });
  });

  it('detects a flat PostToolUse payload by the presence of the error key', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      toolCall: { name: 'Write', args: { path: '/tmp/file.txt' } },
      error: '',
    });

    expect(result.toolName).toBe('Write');
    expect(result.toolInput).toEqual({ path: '/tmp/file.txt' });
    expect(result.toolResponse).toEqual({ status: 'completed' });
  });

  it('surfaces a PostToolUse error string as the tool response', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      toolCall: { name: 'Write', args: {} },
      error: 'permission denied',
    });
    expect(result.toolResponse).toEqual({ error: 'permission denied' });
  });

  it('does not treat a Stop payload (error key, no toolCall) as a tool event', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      error: '',
      executionNum: 0,
      terminationReason: 'NO_TOOL_CALL',
    });
    expect(result.toolName).toBeUndefined();
  });
});

describe('antigravityCliAdapter - formatOutput (strict protojson contract)', () => {
  it('returns injectSteps with ANSI codes stripped when context is present', () => {
    const raw = '[31mRed text[0m';
    const result = antigravityCliAdapter.formatOutput(
      { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: raw } },
      {},
    ) as Record<string, any>;
    expect(result.injectSteps).toEqual([{ ephemeralMessage: 'Red text' }]);
    expect(result.continue).toBeUndefined();
  });

  it('returns allowTool:true for a PreToolUse raw input (missing allowTool would deny all tools)', () => {
    const result = antigravityCliAdapter.formatOutput(
      {},
      { toolCall: { name: 'Read', args: {} } },
    );
    expect(result).toEqual({ allowTool: true });
  });

  it('returns an empty object for non-preTool no-op results (no unknown proto fields)', () => {
    expect(antigravityCliAdapter.formatOutput({ suppressOutput: true }, { error: '' })).toEqual({});
  });

  it('returns a deny decision when the hook blocks', () => {
    const result = antigravityCliAdapter.formatOutput(
      { continue: false, reason: 'nope' },
      { toolCall: { name: 'Read', args: {} } },
    ) as Record<string, any>;
    expect(result.allowTool).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('nope');
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

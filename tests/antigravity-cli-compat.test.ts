import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { antigravityCliAdapter } from '../src/cli/adapters/antigravity-cli.js';
import { extractLastMessage } from '../src/shared/transcript-parser.js';

const INSTALLER_PATH = 'src/services/integrations/AntigravityCliHooksInstaller.ts';

// These assertions lock in the REAL agy 1.2.1 hook contract (issue #4057).
// The prior version of this file asserted the legacy Gemini-CLI event map
// (BeforeTool/AfterTool/BeforeAgent/SessionStart) written into settings.json —
// none of which agy actually fires — so it "passed" while recording zero
// observations. Do not reintroduce those names.
describe('AntigravityCliHooksInstaller - agy 1.2.1 event map', () => {
  const src = readFileSync(INSTALLER_PATH, 'utf-8');

  it('maps PreInvocation to context (the injectSteps context-injection point)', () => {
    expect(src).toContain("'PreInvocation': 'context'");
  });

  it('maps PreToolUse and PostToolUse to observation', () => {
    expect(src).toContain("'PreToolUse': 'observation'");
    expect(src).toContain("'PostToolUse': 'observation'");
  });

  it('maps PostInvocation to observation', () => {
    expect(src).toContain("'PostInvocation': 'observation'");
  });

  it('maps Stop to summarize', () => {
    expect(src).toContain("'Stop': 'summarize'");
  });

  it('does NOT register the legacy Gemini-CLI event names (0 occurrences in agy)', () => {
    expect(src).not.toContain("'BeforeTool'");
    expect(src).not.toContain("'AfterTool'");
    expect(src).not.toContain("'BeforeAgent'");
    expect(src).not.toContain("'AfterAgent'");
    expect(src).not.toContain("'SessionStart':");
    expect(src).not.toContain("'PreCompress'");
    expect(src).not.toContain("'Notification':");
  });

  it('uses the antigravity-cli hook command string, not gemini-cli', () => {
    expect(src).toContain('hook antigravity-cli');
    expect(src).not.toContain('hook gemini-cli');
  });
});

describe('AntigravityCliHooksInstaller - hooks.json target (not settings.json)', () => {
  const src = readFileSync(INSTALLER_PATH, 'utf-8');

  it('writes hooks to ~/.gemini/config/hooks.json (the file agy loads)', () => {
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'config', 'hooks.json')");
    expect(src).toContain('writeAntigravityHooksConfig');
  });

  it('does not write hooks into settings.json on install', () => {
    // settings.json is only referenced for LEGACY uninstall cleanup, never for
    // writing hooks. Install must go through the hooks.json writer.
    expect(src).toContain('writeAntigravityHooksAndSetupContext(mergedHooks)');
    expect(src).toContain('writeAntigravityHooksConfig(mergedHooks)');
  });

  it('emits bare (unquoted) forward-slashed hook command paths (agy splits on spaces, keeps quotes)', () => {
    expect(src).toContain('hook antigravity-cli ${internalEvent}');
    expect(src).not.toContain('"${escapedBunPath}" "${escapedWorkerPath}"');
  });

  it('still targets the shared ~/.gemini GEMINI.md context file', () => {
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'GEMINI.md')");
  });

  it('dual-writes MCP config to both B0-confirmed candidate paths', () => {
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'antigravity', 'mcp_config.json')");
    expect(src).toContain("path.join(GEMINI_CONFIG_DIR, 'config', 'mcp_config.json')");
  });

  it('writes the rules/context placeholder to the plural, home-relative .agents/rules path', () => {
    expect(src).toContain("path.join(homedir(), '.agents', 'rules', 'claude-mem-context.md')");
  });
});

describe('antigravityCliAdapter - normalizeInput (camelCase protojson stdin)', () => {
  it('reads cwd from workspacePaths[0]', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp/agy-workspace'],
      conversationId: 'conv-1',
    });
    expect(result.cwd).toBe('/tmp/agy-workspace');
  });

  it('reads sessionId from conversationId', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'conv-abc',
    });
    expect(result.sessionId).toBe('conv-abc');
  });

  it('reads transcriptPath from the camelCase transcriptPath field', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      transcriptPath: '/tmp/does-not-exist.jsonl',
    });
    expect(result.transcriptPath).toBe('/tmp/does-not-exist.jsonl');
  });

  it('falls back to process.cwd() when nothing provides a cwd', () => {
    const savedCwd = process.env.GEMINI_CWD;
    const savedProjectDir = process.env.GEMINI_PROJECT_DIR;
    const savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.GEMINI_CWD;
    delete process.env.GEMINI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const result = antigravityCliAdapter.normalizeInput({ conversationId: 'c' });
      expect(result.cwd).toBe(process.cwd());
    } finally {
      if (savedCwd !== undefined) process.env.GEMINI_CWD = savedCwd;
      if (savedProjectDir !== undefined) process.env.GEMINI_PROJECT_DIR = savedProjectDir;
      if (savedClaudeDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
    }
  });

  it('extracts toolName/toolInput from a PreToolUse toolCall and marks it pre-execution', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Read', args: { path: '/tmp/x' } },
      stepIdx: 3,
    });
    expect(result.toolName).toBe('Read');
    expect(result.toolInput).toEqual({ path: '/tmp/x' });
    expect(result.toolResponse).toEqual({ _preExecution: true });
  });

  it('records a PostToolUse error from the error key', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Bash', args: { command: 'boom' } },
      error: 'command failed',
    });
    expect(result.toolName).toBe('Bash');
    expect(result.toolResponse).toEqual({ error: 'command failed' });
  });

  it('maps an invocation payload to the AntigravityProvider provider fields', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      invocationNum: 1,
      initialNumSteps: 0,
    });
    expect(result.toolName).toBe('AntigravityProvider');
    expect(result.toolInput).toEqual({ prompt: 'User Query' });
    expect(result.toolResponse).toEqual({ response: 'Completed' });
  });

  it('pulls prompt (USER_INPUT) and response (PLANNER_RESPONSE) from the transcript on an invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-transcript-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>fix the bug</USER_REQUEST>' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'RUN_COMMAND', content: 'ls' }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'I fixed it.' }),
      ].join('\n') + '\n',
    );

    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: [dir],
      conversationId: 'c',
      transcriptPath,
      invocationNum: 1,
      initialNumSteps: 0,
    });

    expect(result.prompt).toBe('fix the bug');
    expect(result.toolInput).toEqual({ prompt: 'fix the bug' });
    expect(result.toolResponse).toEqual({ response: 'I fixed it.' });
  });
});

describe('antigravityCliAdapter - formatOutput (strict protojson stdout)', () => {
  it('emits {"decision":"allow"} for a PreToolUse (toolCall, no error)', () => {
    antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Read', args: {} },
    });
    const out = antigravityCliAdapter.formatOutput({ continue: true, suppressOutput: true }) as Record<string, unknown>;
    expect(out).toEqual({ decision: 'allow' });
  });

  it('emits {} for a PostToolUse (toolCall + error key)', () => {
    antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Read', args: {} },
      error: '',
    });
    const out = antigravityCliAdapter.formatOutput({ continue: true, suppressOutput: true }) as Record<string, unknown>;
    expect(out).toEqual({});
  });

  it('emits injectSteps for a context-injection result and strips ANSI', () => {
    antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      invocationNum: 1,
    });
    const out = antigravityCliAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '\u001b[31mpast context\u001b[0m' },
    }) as Record<string, unknown>;
    expect(out).toEqual({ injectSteps: [{ ephemeralMessage: 'past context' }] });
  });

  it('emits {} for an invocation/Stop result with no context', () => {
    antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      terminationReason: 'done',
    });
    const out = antigravityCliAdapter.formatOutput({ continue: true, suppressOutput: true }) as Record<string, unknown>;
    expect(out).toEqual({});
  });

  it('emits a deny decision when the result blocks', () => {
    antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Read', args: {} },
    });
    const out = antigravityCliAdapter.formatOutput({ continue: false, reason: 'nope' }) as Record<string, unknown>;
    expect(out).toEqual({ decision: 'deny', reason: 'nope' });
  });

  it('never emits Claude-style continue/systemMessage/hookSpecificOutput fields', () => {
    antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Read', args: {} },
    });
    const out = antigravityCliAdapter.formatOutput({
      continue: true,
      systemMessage: 'hi',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '' },
    }) as Record<string, unknown>;
    // Whatever protojson shape it picks, it MUST NOT carry the Claude-style
    // continue/systemMessage/hookSpecificOutput fields that break agy's parser.
    expect('continue' in out).toBe(false);
    expect('systemMessage' in out).toBe(false);
    expect('hookSpecificOutput' in out).toBe(false);
  });
});

describe('transcript-parser - Antigravity PLANNER_RESPONSE / USER_INPUT nodes', () => {
  function writeTranscript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'agy-parser-'));
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return p;
  }

  it('extracts the last PLANNER_RESPONSE as the assistant message', () => {
    const p = writeTranscript([
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'hello' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'first answer' },
      { type: 'RUN_COMMAND', source: 'MODEL', content: 'ls -la' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'final answer' },
    ]);
    expect(extractLastMessage(p, 'assistant')).toBe('final answer');
  });

  it('extracts the last USER_INPUT as the user message', () => {
    const p = writeTranscript([
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'first request' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'ok' },
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'second request' },
    ]);
    expect(extractLastMessage(p, 'user')).toBe('second request');
  });

  it('does not treat MODEL-sourced tool nodes as assistant text', () => {
    const p = writeTranscript([
      { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'the real answer' },
      { type: 'VIEW_FILE', source: 'MODEL', content: 'file contents that must be ignored' },
    ]);
    expect(extractLastMessage(p, 'assistant')).toBe('the real answer');
  });
});

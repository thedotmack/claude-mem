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

  it('prefers an explicit cwd over any env var fallback', () => {
    const result = antigravityCliAdapter.normalizeInput({ cwd: '/tmp/explicit-cwd' });
    expect(result.cwd).toBe('/tmp/explicit-cwd');
  });

  it('falls back to process.cwd() when cwd is an empty string (#3887)', () => {
    const result = antigravityCliAdapter.normalizeInput({ cwd: '' });
    expect(result.cwd).toBe(process.cwd());
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

  it('marks a BeforeTool call as pre-execution when no response is present', () => {
    const result = antigravityCliAdapter.normalizeInput({
      cwd: '/tmp',
      hook_event_name: 'BeforeTool',
      tool_name: 'Read',
    });
    expect(result.toolResponse).toEqual({ _preExecution: true });
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
  it('formats systemMessage into injectSteps and strips ANSI escape codes', () => {
    const raw = '\u001b[31mRed text\u001b[0m';
    const result = antigravityCliAdapter.formatOutput({ systemMessage: raw }) as Record<string, unknown>;
    expect(result.injectSteps).toEqual([{ ephemeralMessage: 'Red text' }]);
  });

  it('formats injectSteps for Antigravity CLI PreInvocation ephemeral context', () => {
    const result = antigravityCliAdapter.formatOutput({
      hookSpecificOutput: { additionalContext: 'Project memory timeline' },
    }) as Record<string, unknown>;
    expect(result.injectSteps).toEqual([
      { ephemeralMessage: 'Project memory timeline' },
    ]);
  });

  it('returns an empty object {} for PostToolUse to comply with Antigravity protojson', () => {
    const result = antigravityCliAdapter.formatOutput({
      continue: true,
      suppressOutput: true,
    }) as Record<string, unknown>;
    expect(result).toEqual({});
  });
});

describe('antigravityCliAdapter - native camelCase and toolCall support', () => {
  it('normalizes Antigravity CLI camelCase conversationId, workspacePaths, and toolCall', () => {
    const result = antigravityCliAdapter.normalizeInput({
      conversationId: 'conv-12345',
      workspacePaths: ['/path/to/project'],
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'npm test' },
      },
    });

    expect(result.sessionId).toBe('conv-12345');
    expect(result.cwd).toBe('/path/to/project');
    expect(result.toolName).toBe('run_command');
    expect(result.toolInput).toEqual({ CommandLine: 'npm test' });
  });

  it('normalizes Antigravity CLI Stop event termination payload', () => {
    const result = antigravityCliAdapter.normalizeInput({
      conversationId: 'conv-999',
      workspacePaths: ['/path/to/project'],
      transcriptPath: '/path/to/transcript.jsonl',
      terminationReason: 'model_stop',
    });

    expect(result.sessionId).toBe('conv-999');
    expect(result.cwd).toBe('/path/to/project');
    expect(result.transcriptPath).toBe('/path/to/transcript.jsonl');
  });
});

describe('platform-source - antigravity-cli support', () => {
  it('normalizes antigravity, agy, and antigravity-cli to antigravity-cli', async () => {
    const { normalizePlatformSource, sortPlatformSources } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('antigravity')).toBe('antigravity-cli');
    expect(normalizePlatformSource('agy')).toBe('antigravity-cli');
    expect(normalizePlatformSource('antigravity-cli')).toBe('antigravity-cli');
    expect(normalizePlatformSource('ANTIGRAVITY')).toBe('antigravity-cli');

    const sorted = sortPlatformSources(['cursor', 'antigravity-cli', 'codex', 'claude']);
    expect(sorted).toEqual(['claude', 'codex', 'antigravity-cli', 'cursor']);
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

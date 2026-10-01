import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { antigravityCliAdapter } from '../src/cli/adapters/antigravity-cli.js';
import { extractLastMessage } from '../src/shared/transcript-parser.js';
import {
  buildAntigravityHooksConfig,
  describeAntigravityHooks,
  mergeHooksIntoConfig,
  removeClaudeMemHooks,
} from '../src/services/integrations/AntigravityCliHooksInstaller.js';

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

// Issue #4196: the pre-fix installer wrote top-level EVENT keys, wrapped every
// event in a {matcher, hooks} group, tagged each handler with name:'claude-mem',
// and used timeout:10000. agy's builtin `agy-customizations/docs/hooks.md`
// (verified against 1.2.13) requires top-level HOOK names, grouped shape only
// for PreToolUse/PostToolUse, flat handler arrays for the rest, and timeout in
// seconds. These tests assert the real JSON shape (not source strings).
describe('AntigravityCliHooksInstaller - agy hooks.json schema (issue #4196)', () => {
  const BUN = '/usr/local/bin/bun';
  const WORKER = '/home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs';
  const config = buildAntigravityHooksConfig(BUN, WORKER) as Record<string, any>;
  const claudeMem = config['claude-mem'];

  it('nests every event under the "claude-mem" hook name (not event names)', () => {
    expect(Object.keys(config)).toEqual(['claude-mem']);
    for (const event of ['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']) {
      expect(Array.isArray(claudeMem[event])).toBe(true);
    }
  });

  it('uses the grouped (matcher + hooks) shape only for PreToolUse/PostToolUse', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const groups = claudeMem[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].matcher).toBe('*');
      expect(Array.isArray(groups[0].hooks)).toBe(true);
      expect(groups[0].hooks[0].command).toContain('hook antigravity-cli');
    }
  });

  it('uses flat handler arrays for PreInvocation/PostInvocation/Stop', () => {
    for (const event of ['PreInvocation', 'PostInvocation', 'Stop']) {
      const handlers = claudeMem[event];
      expect(handlers).toHaveLength(1);
      expect(handlers[0].command).toContain('hook antigravity-cli');
      expect(handlers[0].matcher).toBeUndefined();
      expect(handlers[0].hooks).toBeUndefined();
    }
  });

  it('writes timeout in seconds (agy default 30), never the old 10000', () => {
    const handlers = [
      claudeMem.PreInvocation[0],
      claudeMem.PreToolUse[0].hooks[0],
      claudeMem.PostToolUse[0].hooks[0],
      claudeMem.PostInvocation[0],
      claudeMem.Stop[0],
    ];
    for (const handler of handlers) {
      expect(handler.timeout).toBe(30);
      expect(handler.timeout).not.toBe(10000);
      expect(handler.type).toBe('command');
    }
  });

  it('keeps the hook name on the top-level key, not on individual handlers', () => {
    expect(claudeMem.PreInvocation[0].name).toBeUndefined();
    expect(claudeMem.PreToolUse[0].hooks[0].name).toBeUndefined();
  });
});

describe('AntigravityCliHooksInstaller - merge/uninstall migrate and preserve', () => {
  const BUN = '/usr/local/bin/bun';
  const WORKER = '/home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs';

  it('preserves other named hooks and replaces claude-mem idempotently', () => {
    const existing = {
      'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] },
      'claude-mem': { PreInvocation: [{ command: 'stale-command' }] },
    } as unknown as Parameters<typeof mergeHooksIntoConfig>[0];

    const merged = mergeHooksIntoConfig(existing, buildAntigravityHooksConfig(BUN, WORKER)) as Record<string, any>;

    expect(merged['lint-checker']).toEqual(existing['lint-checker']);
    expect(merged['claude-mem'].PreInvocation).toHaveLength(1);
    expect(merged['claude-mem'].PreInvocation[0].command).not.toBe('stale-command');

    const twice = mergeHooksIntoConfig(
      merged as unknown as Parameters<typeof mergeHooksIntoConfig>[0],
      buildAntigravityHooksConfig(BUN, WORKER),
    ) as Record<string, any>;
    expect(twice['claude-mem'].PreInvocation).toHaveLength(1);
    expect(twice['claude-mem'].PreToolUse).toHaveLength(1);
  });

  it('migrates legacy event-keyed claude-mem entries and keeps others', () => {
    const existing = {
      PreInvocation: [{ matcher: '*', hooks: [{ name: 'claude-mem', type: 'command', command: 'old', timeout: 10000 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ name: 'claude-mem', type: 'command', command: 'old' }] }],
      'other-tool': { Stop: [{ command: './other.sh' }] },
    } as unknown as Parameters<typeof mergeHooksIntoConfig>[0];

    const merged = mergeHooksIntoConfig(existing, buildAntigravityHooksConfig(BUN, WORKER)) as Record<string, any>;

    expect(merged.PreInvocation).toBeUndefined();
    expect(merged.PreToolUse).toBeUndefined();
    expect(merged['other-tool']).toEqual(existing['other-tool']);
    expect(merged['claude-mem'].PreInvocation).toHaveLength(1);
  });

  it('uninstall removes only claude-mem (named + legacy) and keeps other hooks', () => {
    const config = {
      'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] },
      'claude-mem': {
        PreInvocation: [{ command: 'a' }],
        PreToolUse: [{ matcher: '*', hooks: [{ command: 'b' }] }],
      },
      PreToolUse: [{ matcher: '*', hooks: [{ name: 'claude-mem', command: 'c' }, { name: 'other', command: 'd' }] }],
    } as unknown as Parameters<typeof removeClaudeMemHooks>[0];

    const { config: cleaned, removed } = removeClaudeMemHooks(config) as { config: Record<string, any>; removed: number };

    expect(cleaned['claude-mem']).toBeUndefined();
    expect(cleaned['lint-checker']).toEqual((config as Record<string, any>)['lint-checker']);
    expect(cleaned.PreToolUse).toHaveLength(1);
    expect(cleaned.PreToolUse[0].hooks).toHaveLength(1);
    expect(cleaned.PreToolUse[0].hooks[0].name).toBe('other');
    expect(removed).toBe(3);
  });
});

describe('AntigravityCliHooksInstaller - status sees leftover legacy hooks (issue #4196)', () => {
  const BUN = '/usr/local/bin/bun';
  const WORKER = '/home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs';

  it('counts legacy claude-mem handlers next to a current install, without touching the config', () => {
    const config = {
      ...buildAntigravityHooksConfig(BUN, WORKER),
      PreToolUse: [{ matcher: '*', hooks: [{ name: 'claude-mem', command: 'old' }, { name: 'other', command: 'keep' }] }],
      Stop: [{ matcher: '*', hooks: [{ name: 'claude-mem', command: 'old', timeout: 10000 }] }],
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    const { installedEvents, legacyHandlerCount } = describeAntigravityHooks(config);

    expect(installedEvents).toEqual(['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']);
    expect(legacyHandlerCount).toBe(2);
    expect((config as Record<string, any>).PreToolUse[0].hooks).toHaveLength(2);
    expect((config as Record<string, any>).Stop).toHaveLength(1);
  });

  it("does not count another tool's top-level event arrays as claude-mem leftovers", () => {
    const config = {
      Stop: [{ matcher: '*', hooks: [{ name: 'other', command: './other.sh' }] }],
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    expect(describeAntigravityHooks(config)).toEqual({ installedEvents: [], legacyHandlerCount: 0 });
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

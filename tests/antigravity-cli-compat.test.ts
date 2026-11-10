import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { antigravityCliAdapter } from '../src/cli/adapters/antigravity-cli.js';
import { extractLastMessage } from '../src/shared/transcript-parser.js';
import {
  buildAntigravityHooksConfig,
  describeAntigravityHooks,
  mergeHooksIntoConfig,
  removeClaudeMemHooks,
  toSpaceFreePath,
} from '../src/services/integrations/AntigravityCliHooksInstaller.js';

describe('AntigravityCliHooksInstaller - agy hooks.json schema', () => {
  const BUN = '/usr/local/bin/bun';
  const WORKER = '/home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs';
  const h = (event: string) => ({ type: 'command', command: `${BUN} ${WORKER} hook antigravity-cli ${event}`, timeout: 30 });

  it('writes the exact named hook shapes and event mappings', () => {
    expect(buildAntigravityHooksConfig(BUN, WORKER)).toEqual({
      'claude-mem': {
        SessionStart: [h('context')],
        PreInvocation: [h('session-init')],
        PostToolUse: [{ matcher: '*', hooks: [h('observation')] }],
        PostInvocation: [h('observation')],
        Stop: [h('summarize')],
      },
    });
  });

  it('normalizes a Windows Bun path in the hook command', () => {
    const config = buildAntigravityHooksConfig(String.raw`C:\bun\bun.exe`, WORKER) as Record<string, any>;
    expect(config['claude-mem'].SessionStart[0].command).toBe(`C:/bun/bun.exe ${WORKER} hook antigravity-cli context`);
  });
});

describe('AntigravityCliHooksInstaller - merge/uninstall migrate and preserve', () => {
  const BUN = '/usr/local/bin/bun';
  const WORKER = '/home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs';

  it('preserves other named hooks and replaces claude-mem idempotently', () => {
    const existing = {
      'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] },
      'claude-mem': {
        SessionStart: [{ command: 'stale-command' }],
        PreInvocation: [{ command: 'legacy-pre-inv' }],
        PreToolUse: [{ matcher: '*', hooks: [{ command: 'legacy-pre-tool' }] }],
      },
    } as unknown as Parameters<typeof mergeHooksIntoConfig>[0];

    const merged = mergeHooksIntoConfig(existing, buildAntigravityHooksConfig(BUN, WORKER)) as Record<string, any>;

    expect(merged['lint-checker']).toEqual(existing['lint-checker']);
    expect(merged['claude-mem'].SessionStart).toHaveLength(1);
    expect(merged['claude-mem'].SessionStart[0].command).not.toBe('stale-command');
    expect(merged['claude-mem'].PreInvocation).toHaveLength(1);
    expect(merged['claude-mem'].PreInvocation[0].command).toContain('session-init');
    expect(merged['claude-mem'].PreInvocation[0].command).not.toContain('legacy-pre-inv');
    expect(merged['claude-mem'].PreToolUse).toBeUndefined();

    const twice = mergeHooksIntoConfig(
      merged as unknown as Parameters<typeof mergeHooksIntoConfig>[0],
      buildAntigravityHooksConfig(BUN, WORKER),
    ) as Record<string, any>;
    expect(twice['claude-mem'].SessionStart).toHaveLength(1);
    expect(twice['claude-mem'].PostToolUse).toHaveLength(1);
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
    expect(merged['claude-mem'].SessionStart).toHaveLength(1);
  });

  it('uninstall removes only claude-mem (named + legacy) and keeps other hooks', () => {
    const config = {
      'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] },
      'claude-mem': {
        SessionStart: [{ command: 'a' }],
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

    const { installedEvents, legacyHandlerCount, hasStalePreInvocation } = describeAntigravityHooks(config);

    expect(installedEvents).toEqual(['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation', 'Stop']);
    expect(legacyHandlerCount).toBe(2);
    expect(hasStalePreInvocation).toBe(false);
    expect((config as Record<string, any>).PreToolUse[0].hooks).toHaveLength(2);
    expect((config as Record<string, any>).Stop).toHaveLength(1);
  });

  it('flags stale PreInvocation handler in named claude-mem config (issue #4911, #4912)', () => {
    const config = {
      'claude-mem': {
        PreInvocation: [{ command: 'bun worker-service.cjs hook antigravity-cli context' }],
        PostToolUse: [{ matcher: '*', hooks: [{ command: 'bun worker-service.cjs hook antigravity-cli observation' }] }],
      },
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    const { installedEvents, legacyHandlerCount, hasStalePreInvocation } = describeAntigravityHooks(config);

    expect(hasStalePreInvocation).toBe(true);
    // The stale context handler is not the session-init mapping, so it isn't installed.
    expect(installedEvents).toEqual(['PostToolUse']);
    expect(legacyHandlerCount).toBe(0);
  });

  it('treats a PreInvocation routed to session-init as current, not stale (#5078)', () => {
    const config = {
      'claude-mem': {
        PreInvocation: [{ command: 'bun worker-service.cjs hook antigravity-cli session-init' }],
      },
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    const { installedEvents, hasStalePreInvocation } = describeAntigravityHooks(config);

    expect(hasStalePreInvocation).toBe(false);
    expect(installedEvents).toEqual(['PreInvocation']);
  });

  it("does not count another tool's top-level event arrays as claude-mem leftovers", () => {
    const config = {
      Stop: [{ matcher: '*', hooks: [{ name: 'other', command: './other.sh' }] }],
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    expect(describeAntigravityHooks(config)).toEqual({ installedEvents: [], legacyHandlerCount: 0, hasStalePreInvocation: false });
  });
});

describe('antigravityCliAdapter - normalizeInput (camelCase protojson stdin)', () => {
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

  it('records a successful PostToolUse, which carries no error key (#5078)', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Read', args: { path: '/tmp/x' } },
      stepIdx: 3,
    });
    expect(result.toolName).toBe('Read');
    expect(result.toolInput).toEqual({ path: '/tmp/x' });
    expect(result.toolResponse).toEqual({ status: 'completed' });
  });

  it('records a PostToolUse error from the error key', () => {
    const result = antigravityCliAdapter.normalizeInput({
      workspacePaths: ['/tmp'],
      conversationId: 'c',
      toolCall: { name: 'Bash', args: { command: 'boom' } },
      error: 'command failed',
    });
    expect(result.toolName).toBe('Bash');
    expect(result.toolResponse).toEqual({ is_error: true, error: 'command failed' });
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
    expect(result.toolInput).toEqual({ CommandLine: 'npm test', command: 'npm test' });
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

    expect(normalizePlatformSource('Antigravity CLI')).toBe('antigravity-cli');

    const sorted = sortPlatformSources(['cursor', 'antigravity-cli', 'codex', 'claude']);
    expect(sorted).toEqual(['claude', 'codex', 'antigravity-cli', 'cursor']);
  });

  it('matches whole tokens only, so unrelated names are left alone', async () => {
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('legacy-agy-tool')).toBe('legacy-agy-tool');
    expect(normalizePlatformSource('agyle')).toBe('agyle');
  });


});

describe('antigravityCliAdapter - formatOutput (strict protojson stdout)', () => {
  it('emits {} for a successful result', () => {
    expect(antigravityCliAdapter.formatOutput({ continue: true, suppressOutput: true })).toEqual({});
  });

  it('emits injectSteps for a context-injection result and strips ANSI', () => {
    expect(antigravityCliAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '\u001b[31mpast context\u001b[0m' },
    })).toEqual({ injectSteps: [{ ephemeralMessage: 'past context' }] });
  });

  it('emits a deny decision when the result blocks', () => {
    expect(antigravityCliAdapter.formatOutput({ continue: false, reason: 'nope' })).toEqual({ decision: 'deny', reason: 'nope' });
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

// agy splits hook commands on spaces, so the installer writes the 8.3 short
// form of a Windows path that has one. The lookup ran `for %~I`, which cmd
// rejects at the command line, so it never shortened anything.
describe.skipIf(process.platform !== 'win32')('toSpaceFreePath on Windows', () => {
  it('returns the 8.3 short path Windows reports for a path with a space', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-short-'));
    try {
      const dir = join(root, 'with space');
      mkdirSync(dir);
      const file = join(dir, 'bun.exe');
      writeFileSync(file, '');
      const expected = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:P).ShortPath'],
        { encoding: 'utf-8', env: { ...process.env, P: file } }).stdout.trim();
      // A volume with 8.3 names disabled has no short form; the raw path comes back.
      // Windows paths compare case-insensitively; cmd and the COM object differ in case.
      expect(toSpaceFreePath(file).toLowerCase()).toBe((expected.includes(' ') ? file : expected).toLowerCase());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

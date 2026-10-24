import { describe, it, expect, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { antigravityCliAdapter } from '../src/cli/adapters/antigravity-cli.js';
import { extractLastMessage } from '../src/shared/transcript-parser.js';
import { describeAntigravityHooks } from '../src/services/integrations/AntigravityCliHooksInstaller.js';
import { WIRE_GATEWAY_DIR } from '../src/shared/paths.js';
import {
  ANTIGRAVITY_HOOK_TABLE,
  antigravityHookItems,
  antigravityHooksMigration,
  type LibraryInstallEnvironment,
} from '../src/services/wire-gateway/library/agent-library-targets.js';
import { applyLibrary, removeLibrary } from '../src/services/wire-gateway/library/library-engine.js';

// These assertions lock in the REAL agy 1.2.1 hook contract (issue #4057).
// The prior version of this file asserted the legacy Gemini-CLI event map
// (BeforeTool/AfterTool/BeforeAgent/SessionStart) written into settings.json —
// none of which agy actually fires — so it "passed" while recording zero
// observations. Do not reintroduce those names. The table and the writes
// live in the Library (wire-gateway/library/agent-library-targets.ts).

const SANDBOX = join(WIRE_GATEWAY_DIR, 'tmp', `antigravity-compat-${process.pid}`);
mkdirSync(SANDBOX, { recursive: true });
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));
let sandboxCounter = 0;

const BUN = '/usr/local/bin/bun';
const WORKER = '/home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs';
const environment: LibraryInstallEnvironment = {
  home: SANDBOX, env: {}, platform: 'linux', cwd: SANDBOX, bunPath: BUN, workerServicePath: WORKER, mcpServerPath: null, nodePath: '/usr/bin/node',
};

/** A fresh hooks.json path and Library record directory. */
function sandbox(initial?: unknown): { hooksPath: string; context: { libraryDirectory: string } } {
  const root = join(SANDBOX, String(sandboxCounter++));
  mkdirSync(root, { recursive: true });
  const hooksPath = join(root, 'hooks.json');
  if (initial !== undefined) writeFileSync(hooksPath, JSON.stringify(initial, null, 2) + '\n');
  return { hooksPath, context: { libraryDirectory: join(root, 'library') } };
}

function freshInstall(): Record<string, any> {
  const { hooksPath, context } = sandbox();
  return install(hooksPath, context);
}

function install(hooksPath: string, context: { libraryDirectory: string }): Record<string, any> {
  applyLibrary({ agentId: 'antigravity', items: antigravityHookItems(environment, hooksPath, 30), ownedGroups: ['hooks'], migrations: [antigravityHooksMigration(hooksPath)] }, context);
  return JSON.parse(readFileSync(hooksPath, 'utf-8'));
}

describe('Antigravity CLI hook table (agy event map)', () => {
  const internalEventOf = Object.fromEntries(ANTIGRAVITY_HOOK_TABLE.map((row) => [row.event, row.args]));

  it('maps SessionStart to context (the injectSteps startup context-injection point, issue #4911)', () => {
    expect(internalEventOf.SessionStart).toBe('hook antigravity-cli context');
    expect(internalEventOf.PreInvocation).toBeUndefined();
  });

  it('maps PreToolUse, PostToolUse and PostInvocation to observation, Stop to summarize', () => {
    expect(internalEventOf.PreToolUse).toBe('hook antigravity-cli observation');
    expect(internalEventOf.PostToolUse).toBe('hook antigravity-cli observation');
    expect(internalEventOf.PostInvocation).toBe('hook antigravity-cli observation');
    expect(internalEventOf.Stop).toBe('hook antigravity-cli summarize');
  });

  it('does NOT register the legacy Gemini-CLI event names (0 occurrences in agy)', () => {
    expect(Object.keys(internalEventOf).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  });

  it('emits bare (unquoted) forward-slashed hook command paths (agy splits on spaces, keeps quotes)', () => {
    const { hooksPath, context } = sandbox();
    const handler = install(hooksPath, context)['claude-mem'].SessionStart[0];
    expect(handler.command).toBe(`${BUN} ${WORKER} hook antigravity-cli context`);
  });

  // Carried from main (#5032): a Windows-style bun path must come out bare and
  // forward-slashed for every event, since agy splits on spaces and keeps quotes.
  it.each([
    ['SessionStart', 'context'],
    ['PreToolUse', 'observation'],
    ['PostToolUse', 'observation'],
    ['PostInvocation', 'observation'],
    ['Stop', 'summarize'],
  ])('writes %s as a bare forward-slashed Windows command for %s', (event, internalEvent) => {
    const root = join(SANDBOX, String(sandboxCounter++));
    mkdirSync(root, { recursive: true });
    const hooksPath = join(root, 'hooks.json');
    const windowsEnvironment: LibraryInstallEnvironment = { ...environment, platform: 'win32', bunPath: String.raw`C:\bun\bun.exe`, workerServicePath: '/plugin/worker-service.cjs' };
    applyLibrary({ agentId: 'antigravity', items: antigravityHookItems(windowsEnvironment, hooksPath, 30), ownedGroups: ['hooks'] }, { libraryDirectory: join(root, 'library') });
    const [entry] = JSON.parse(readFileSync(hooksPath, 'utf-8'))['claude-mem'][event];
    expect((entry.hooks ? entry.hooks[0] : entry).command).toBe(`C:/bun/bun.exe /plugin/worker-service.cjs hook antigravity-cli ${internalEvent}`);
  });
});

// Issue #4196: the pre-fix installer wrote top-level EVENT keys, wrapped every
// event in a {matcher, hooks} group, tagged each handler with name:'claude-mem',
// and used timeout:10000. agy's builtin `agy-customizations/docs/hooks.md`
// (verified against 1.2.13) requires top-level HOOK names, grouped shape only
// for PreToolUse/PostToolUse, flat handler arrays for the rest, and timeout in
// seconds. These tests assert the real JSON shape (not source strings).
describe('Antigravity CLI hooks.json schema (issue #4196)', () => {
  const { hooksPath, context } = sandbox();
  const config = install(hooksPath, context);
  const claudeMem = config['claude-mem'];

  it('nests every event under the "claude-mem" hook name (not event names)', () => {
    expect(Object.keys(config)).toEqual(['claude-mem']);
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']) {
      expect(Array.isArray(claudeMem[event])).toBe(true);
    }
  });

  it('uses the grouped (matcher + hooks) shape only for PreToolUse/PostToolUse', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const groups = claudeMem[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].matcher).toBe('*');
      expect(groups[0].hooks[0].command).toContain('hook antigravity-cli');
    }
  });

  it('uses flat handler arrays for SessionStart/PostInvocation/Stop', () => {
    for (const event of ['SessionStart', 'PostInvocation', 'Stop']) {
      const handlers = claudeMem[event];
      expect(handlers).toHaveLength(1);
      expect(handlers[0].command).toContain('hook antigravity-cli');
      expect(handlers[0].matcher).toBeUndefined();
      expect(handlers[0].hooks).toBeUndefined();
    }
  });

  it('writes timeout in seconds (agy default 30), never the old 10000', () => {
    for (const handler of [claudeMem.SessionStart[0], claudeMem.PreToolUse[0].hooks[0], claudeMem.PostToolUse[0].hooks[0], claudeMem.PostInvocation[0], claudeMem.Stop[0]]) {
      expect(handler.timeout).toBe(30);
      expect(handler.type).toBe('command');
      expect(handler.name).toBeUndefined();
    }
  });
});

describe('Antigravity CLI install/uninstall migrate and preserve', () => {
  it('preserves other named hooks and replaces claude-mem idempotently', () => {
    const lintChecker = { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] };
    const { hooksPath, context } = sandbox({
      'lint-checker': lintChecker,
      'claude-mem': { SessionStart: [{ command: 'stale-command' }], PreInvocation: [{ command: 'legacy-pre-inv' }] },
    });
    const merged = install(hooksPath, context);
    expect(merged['lint-checker']).toEqual(lintChecker);
    expect(merged['claude-mem'].SessionStart).toHaveLength(1);
    expect(merged['claude-mem'].SessionStart[0].command).not.toBe('stale-command');
    expect(merged['claude-mem'].PreInvocation).toBeUndefined();
    const twice = install(hooksPath, context);
    expect(twice).toEqual(merged);
  });

  it('migrates legacy event-keyed claude-mem entries and keeps others', () => {
    const otherTool = { Stop: [{ command: './other.sh' }] };
    const { hooksPath, context } = sandbox({
      PreInvocation: [{ matcher: '*', hooks: [{ name: 'claude-mem', type: 'command', command: 'old', timeout: 10000 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ name: 'claude-mem', type: 'command', command: 'old' }] }],
      'other-tool': otherTool,
    });
    const merged = install(hooksPath, context);
    expect(merged.PreInvocation).toBeUndefined();
    expect(merged.PreToolUse).toBeUndefined();
    expect(merged['other-tool']).toEqual(otherTool);
    expect(merged['claude-mem'].SessionStart).toHaveLength(1);
  });

  it('uninstall removes only what claude-mem wrote (named + legacy) and keeps other hooks', () => {
    const lintChecker = { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] };
    const { hooksPath, context } = sandbox({
      'lint-checker': lintChecker,
      PreToolUse: [{ matcher: '*', hooks: [{ name: 'claude-mem', command: 'c' }, { name: 'other', command: 'd' }] }],
    });
    install(hooksPath, context);
    removeLibrary({ agentId: 'antigravity', items: antigravityHookItems(environment, hooksPath, 30), migrations: [antigravityHooksMigration(hooksPath)] }, context);
    const cleaned = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    expect(cleaned['claude-mem']).toBeUndefined();
    expect(cleaned['lint-checker']).toEqual(lintChecker);
    expect(cleaned.PreToolUse).toEqual([{ matcher: '*', hooks: [{ name: 'other', command: 'd' }] }]);
  });
});

describe('AntigravityCliHooksInstaller - status sees leftover legacy hooks (issue #4196)', () => {

  it('counts legacy claude-mem handlers next to a current install, without touching the config', () => {
    const config = {
      'claude-mem': freshInstall()['claude-mem'],
      PreToolUse: [{ matcher: '*', hooks: [{ name: 'claude-mem', command: 'old' }, { name: 'other', command: 'keep' }] }],
      Stop: [{ matcher: '*', hooks: [{ name: 'claude-mem', command: 'old', timeout: 10000 }] }],
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    const { installedEvents, legacyHandlerCount, hasStalePreInvocation } = describeAntigravityHooks(config);

    expect(installedEvents).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']);
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
    expect(installedEvents).toEqual(['PostToolUse']);
    expect(legacyHandlerCount).toBe(0);
  });

  it("does not count another tool's top-level event arrays as claude-mem leftovers", () => {
    const config = {
      Stop: [{ matcher: '*', hooks: [{ name: 'other', command: './other.sh' }] }],
    } as unknown as Parameters<typeof describeAntigravityHooks>[0];

    expect(describeAntigravityHooks(config)).toEqual({ installedEvents: [], legacyHandlerCount: 0, hasStalePreInvocation: false });
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

    expect(normalizePlatformSource('Antigravity CLI')).toBe('antigravity-cli');

    const sorted = sortPlatformSources(['cursor', 'antigravity-cli', 'codex', 'claude']);
    expect(sorted).toEqual(['claude', 'codex', 'antigravity-cli', 'cursor']);
  });

  it('matches whole tokens only, so unrelated names are left alone', async () => {
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('legacy-agy-tool')).toBe('legacy-agy-tool');
    expect(normalizePlatformSource('agyle')).toBe('agyle');
  });

  it('gives the source a badge colour in the viewer and on Observation TV', () => {
    const viewer = readFileSync(join(import.meta.dir, '../src/ui/viewer-template.html'), 'utf-8');
    const tv = readFileSync(join(import.meta.dir, '../src/ui/tv.html'), 'utf-8');
    expect(viewer).toContain('.source-antigravity-cli {');
    // Both themes define the badge token: tests/viewer/theme-tokens.test.ts.
    expect(viewer).toContain('var(--color-source-antigravity-cli-text)');
    expect(tv).toContain("'antigravity-cli':");
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

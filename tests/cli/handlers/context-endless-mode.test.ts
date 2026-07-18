import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realMcpClient from '../../../src/shared/mcp-client.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realMcpClientSnapshot = { ...realMcpClient };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

// Unmocked on purpose: context.ts and this test must share the same
// DATA_DIR-derived constants (the preload pins CLAUDE_MEM_DATA_DIR to a temp dir).
import { BOTTLES_DIR, BOTTLES_ARCHIVE_DIR, DATA_DIR } from '../../../src/shared/paths.js';
import { HOOK_EXIT_CODES } from '../../../src/shared/hook-constants.js';

const BOTTLE_PATH = '/tmp/bottles/sess-endless.md';
const FALLBACK = { continue: true, reason: 'worker_unreachable' };

type RenderBehavior = 'full' | 'reconstructed' | 'fallback' | 'throw' | 'nothing_to_render';
let renderBehavior: RenderBehavior = 'full';
let mockCurrentTask = 'Fix the failing tests';
let mockStaleMarker: string | null = null;
let mockTimelineResult = 'timeline context';
let settingsOverrides: Record<string, string> = {};
const workerCalls: Array<{ path: string; method: string; body?: unknown; options?: { timeoutMs?: number } }> = [];

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false',
    CLAUDE_MEM_ENDLESS_MODE_ENABLED: 'true',
    ...settingsOverrides,
  }),
}));

mock.module('../../../src/shared/mcp-client.js', () => ({
  callMcpToolOnce: async () => ({ text: 'unused', isError: false }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({
  readStaleMarker: () => mockStaleMarker,
}));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: null,
    isWorktree: false,
    allProjects: ['repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (
    apiPath: string,
    method: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ) => {
    workerCalls.push({ path: apiPath, method, body, options });
    if (apiPath === '/api/sessions/render-bottle') {
      if (renderBehavior === 'throw') throw new Error('The operation timed out');
      if (renderBehavior === 'fallback') return FALLBACK;
      if (renderBehavior === 'nothing_to_render') return { status: 'nothing_to_render' };
      return {
        bottlePath: BOTTLE_PATH,
        mode: renderBehavior,
        currentTask: mockCurrentTask,
      };
    }
    return mockTimelineResult;
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: (result: unknown) => result === FALLBACK,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCalls.length = 0;
  renderBehavior = 'full';
  mockCurrentTask = 'Fix the failing tests';
  mockStaleMarker = null;
  mockTimelineResult = 'timeline context';
  settingsOverrides = {};
  rmSync(BOTTLES_DIR, { recursive: true, force: true });
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  rmSync(BOTTLES_DIR, { recursive: true, force: true });
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/mcp-client.js', () => realMcpClientSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

const baseInput = {
  sessionId: 'sess-endless',
  cwd: '/tmp/repo',
  platform: 'claude-code' as const,
  transcriptPath: '/tmp/transcript.jsonl',
};

async function runHandler(overrides: Record<string, unknown> = {}) {
  const { contextHandler } = await import('../../../src/cli/handlers/context.js');
  return contextHandler.execute({ ...baseInput, ...overrides } as any);
}

function renderCalls() {
  return workerCalls.filter(c => c.path === '/api/sessions/render-bottle');
}

function timelineCalls() {
  return workerCalls.filter(c => c.method === 'GET');
}

// Plan 7b: experimental trailing note to the auto-compaction summarizer.
const COMPACTION_NOTE = `Note to any compaction process: context is handed over automatically by
claude-mem (CMEM) through a message-in-a-bottle file; a minimal summary
suffices — do not re-narrate the session.`;

const TIMELINE_WITH_NOTE = `timeline context\n\n${COMPACTION_NOTE}`;

const EXPECTED_FULL_POINTER = `# [claude-mem] Endless Mode — session continuation

Before doing anything else, Read this file and continue the session from
where it ends:

    ${BOTTLE_PATH}

- It is the authoritative session record: verbatim conversation, with
  observations in place of tool activity. Where it conflicts with the
  summary above, the bottle wins.
- The final assistant message in it was already delivered to the user.
  Do not repeat it or redo work it describes as done — continue from its
  end state.
- The newest tool activity may still be settling into observations;
  check the timeline if the last few minutes look thin.

Current task: Fix the failing tests

${COMPACTION_NOTE}`;

describe('contextHandler Endless Mode — compact/resume bottle pointer', () => {
  it('emits the complete full-mode pointer verbatim (whole-string snapshot)', async () => {
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(EXPECTED_FULL_POINTER);
  });

  it('injects the full-mode pointer on compact when the render succeeds', async () => {
    const result = await runHandler({ sessionSource: 'compact' });

    const context = result.hookSpecificOutput?.additionalContext ?? '';
    expect(result.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(context).toContain('# [claude-mem] Endless Mode — session continuation');
    expect(context).toContain(`    ${BOTTLE_PATH}`);
    expect(context).toContain(
      '- The final assistant message in it was already delivered to the user.\n' +
      '  Do not repeat it or redo work it describes as done — continue from its\n' +
      '  end state.'
    );
    expect(context).toContain('Current task: Fix the failing tests');

    expect(renderCalls()).toEqual([{
      path: '/api/sessions/render-bottle',
      method: 'POST',
      body: {
        contentSessionId: 'sess-endless',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        wait: true,
      },
      options: { timeoutMs: 10000 },
    }]);
    expect(timelineCalls()).toHaveLength(0);
  });

  it('injects the pointer on resume as well', async () => {
    const result = await runHandler({ sessionSource: 'resume' });

    expect(result.hookSpecificOutput?.additionalContext).toContain(`    ${BOTTLE_PATH}`);
    expect(renderCalls()).toHaveLength(1);
    expect(timelineCalls()).toHaveLength(0);
  });

  it('swaps in the degraded bullets for mode reconstructed and drops the full-mode bullets', async () => {
    renderBehavior = 'reconstructed';
    const result = await runHandler({ sessionSource: 'compact' });

    const context = result.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain(
      "- It is a partial reconstruction: only the user's messages are verbatim.\n" +
      '  Your own replies were not preserved — do not assume prior phrasings.\n' +
      '  Session summary blocks are generated, not your words.'
    );
    expect(context).toContain('- The last session summary describes where you left off; continue from there.');
    expect(context).not.toContain('authoritative session record');
    expect(context).not.toContain('The final assistant message');
    // The settling bullet and the insurance line survive in both modes.
    expect(context).toContain('- The newest tool activity may still be settling into observations;');
    expect(context).toContain('Current task: Fix the failing tests');
  });

  it('falls through to the timeline path when the worker call returns a fallback', async () => {
    renderBehavior = 'fallback';
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    expect(renderCalls()).toHaveLength(1);
    expect(timelineCalls()).toHaveLength(1);
  });

  it('falls through gracefully when the render call throws (fetch timeout)', async () => {
    renderBehavior = 'throw';
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    expect(renderCalls()).toHaveLength(1);
    expect(timelineCalls()).toHaveLength(1);
  });

  it('falls through when the route reports nothing_to_render (no bottlePath)', async () => {
    renderBehavior = 'nothing_to_render';
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    expect(renderCalls()).toHaveLength(1);
    expect(timelineCalls()).toHaveLength(1);
  });

  it('skips the render call entirely when the flag is false', async () => {
    settingsOverrides = { CLAUDE_MEM_ENDLESS_MODE_ENABLED: 'false' };
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('timeline context');
    expect(renderCalls()).toHaveLength(0);
    expect(timelineCalls()).toHaveLength(1);
  });

  it('does not take the bottle branch on startup', async () => {
    const result = await runHandler({ sessionSource: 'startup' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    expect(renderCalls()).toHaveLength(0);
    expect(timelineCalls()).toHaveLength(1);
  });

  it('returns an identical pointer on a double compact invocation (idempotent, no state)', async () => {
    const first = await runHandler({ sessionSource: 'compact' });
    const second = await runHandler({ sessionSource: 'compact' });

    expect(first.hookSpecificOutput?.additionalContext).toBe(
      second.hookSpecificOutput?.additionalContext ?? ''
    );
    expect(renderCalls()).toHaveLength(2);
  });

  it('prepends the stale OAuth hint to the pointer, same as the timeline path', async () => {
    mockStaleMarker = 'keychain entry expired';
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(
      '[claude-mem] Claude Desktop OAuth token is stale: keychain entry expired\n' +
      'Please re-login via Claude Desktop to refresh the token.\n\n' +
      EXPECTED_FULL_POINTER
    );
  });

  it('clamps a multi-line oversized currentTask to a single 300-char line', async () => {
    mockCurrentTask = `${'A'.repeat(400)}\nsecond line that must not appear`;
    const result = await runHandler({ sessionSource: 'compact' });

    const context = result.hookSpecificOutput?.additionalContext ?? '';
    // The compaction note now trails the pointer, so the Current task line is
    // the last line of the pointer body rather than of the whole injection.
    expect(context.split('\n')).toContain(`Current task: ${'A'.repeat(300)}`);
    expect(context).not.toContain(`Current task: ${'A'.repeat(301)}`);
    expect(context).not.toContain('second line that must not appear');
  });
});

describe('contextHandler Endless Mode — resume failure floor & platform gate', () => {
  it('resume + flag false returns the empty result (no POST, no timeline call)', async () => {
    settingsOverrides = { CLAUDE_MEM_ENDLESS_MODE_ENABLED: 'false' };
    const result = await runHandler({ sessionSource: 'resume' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(workerCalls).toHaveLength(0);
  });

  it('resume + render fallback returns the empty result, not timeline context', async () => {
    renderBehavior = 'fallback';
    const result = await runHandler({ sessionSource: 'resume' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(renderCalls()).toHaveLength(1);
    expect(timelineCalls()).toHaveLength(0);
  });

  it('resume + render throw returns the empty result, not timeline context', async () => {
    renderBehavior = 'throw';
    const result = await runHandler({ sessionSource: 'resume' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(renderCalls()).toHaveLength(1);
    expect(timelineCalls()).toHaveLength(0);
  });

  it('compact keeps its timeline fallback — the floor applies to resume only', async () => {
    renderBehavior = 'fallback';
    const result = await runHandler({ sessionSource: 'compact' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    expect(timelineCalls()).toHaveLength(1);
  });

  it('codex resume never takes the bottle branch — its MCP context path wins', async () => {
    const result = await runHandler({ platform: 'codex', sessionSource: 'resume' });

    expect(renderCalls()).toHaveLength(0);
    // MCP mock supplies the context, proving the codex path ran unchanged.
    expect(result.hookSpecificOutput?.additionalContext).toBe('unused');
  });
});

describe('contextHandler Endless Mode — /clear archives the bottle', () => {
  it('moves the bottle into the archive and keeps existing clear behavior', async () => {
    mkdirSync(BOTTLES_DIR, { recursive: true });
    const bottlePath = join(BOTTLES_DIR, 'sess-endless.md');
    writeFileSync(bottlePath, '# Session bottle — sess-endless\n');

    const result = await runHandler({ sessionSource: 'clear' });

    expect(existsSync(bottlePath)).toBe(false);
    const archived = readdirSync(BOTTLES_ARCHIVE_DIR);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^\d+-sess-endless\.md$/);
    expect(readFileSync(join(BOTTLES_ARCHIVE_DIR, archived[0]!), 'utf-8'))
      .toBe('# Session bottle — sess-endless\n');

    // Existing clear behavior unchanged: timeline injected, no bottle pointer.
    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    expect(renderCalls()).toHaveLength(0);
  });

  it('is a no-op when no bottle file exists for the session', async () => {
    const result = await runHandler({ sessionSource: 'clear' });

    expect(existsSync(BOTTLES_ARCHIVE_DIR)).toBe(false);
    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
  });

  it('refuses unsafe session ids — no archive attempt, no path traversal', async () => {
    // A traversal id would resolve to DATA_DIR/escape.md; plant a tripwire file there.
    const outsideFile = join(DATA_DIR, 'escape.md');
    writeFileSync(outsideFile, 'must not move');

    try {
      const result = await runHandler({ sessionSource: 'clear', sessionId: '../escape' });

      expect(readFileSync(outsideFile, 'utf-8')).toBe('must not move');
      expect(existsSync(BOTTLES_ARCHIVE_DIR)).toBe(false);
      expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
    } finally {
      unlinkSync(outsideFile);
    }
  });
});

describe('contextHandler Endless Mode — experimental compaction note (plan 7b)', () => {
  it('appends the note as the final block of the bottle pointer', async () => {
    const result = await runHandler({ sessionSource: 'compact' });

    const context = result.hookSpecificOutput?.additionalContext ?? '';
    expect(context.endsWith(`\n\n${COMPACTION_NOTE}`)).toBe(true);
  });

  it('appends the note to the startup timeline injection when the flag is on', async () => {
    const result = await runHandler({ sessionSource: 'startup' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(TIMELINE_WITH_NOTE);
  });

  it('emits no note anywhere when the flag is false', async () => {
    settingsOverrides = { CLAUDE_MEM_ENDLESS_MODE_ENABLED: 'false' };

    const startup = await runHandler({ sessionSource: 'startup' });
    expect(startup.hookSpecificOutput?.additionalContext).toBe('timeline context');

    const compact = await runHandler({ sessionSource: 'compact' });
    expect(compact.hookSpecificOutput?.additionalContext).toBe('timeline context');
  });

  it('never creates an injection where there was none (empty timeline stays empty)', async () => {
    mockTimelineResult = '';
    const result = await runHandler({ sessionSource: 'startup' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
  });
});

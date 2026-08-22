import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import { sessionInitHandler } from '../../../src/cli/handlers/session-init.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';
import { hasInjected, markInjected } from '../../../src/shared/kimi-context-gate.js';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

const ORIGINAL_PORT = process.env.CLAUDE_MEM_WORKER_PORT;
const CLOSED_PORT = '65432';

describe('sessionInitContextHandler composite', () => {
  let dataDir: string;
  const origDataDir = process.env.CLAUDE_MEM_DATA_DIR;

  beforeAll(() => {
    process.env.CLAUDE_MEM_WORKER_PORT = CLOSED_PORT;
    // hermetic gate markers: never touch the real ~/.claude-mem state dir
    dataDir = mkdtempSync(join(tmpdir(), 'kimi-gate-composite-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterAll(() => {
    if (ORIGINAL_PORT === undefined) {
      delete process.env.CLAUDE_MEM_WORKER_PORT;
    } else {
      process.env.CLAUDE_MEM_WORKER_PORT = ORIGINAL_PORT;
    }
    if (origDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves against an unreachable worker and returns hookSpecificOutput', async () => {
    const handler = getEventHandler('session-init-context');
    const input: NormalizedHookInput = {
      sessionId: 't',
      cwd: process.cwd(),
      platform: 'kimi',
    };

    const result = await handler.execute(input);

    expect(result).toBeDefined();
    expect(result.hookSpecificOutput).toBeDefined();
    expect(typeof result.hookSpecificOutput).toBe('object');
  });

  it('prepends session-init semantic additionalContext to context output', async () => {
    const handler = getEventHandler('session-init-context');
    const input: NormalizedHookInput = {
      // distinct from the unreachable-worker test's session id: that test may
      // reach a real worker and write the once-per-session gate marker
      sessionId: 't-merge',
      cwd: process.cwd(),
      platform: 'kimi',
    };

    const sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'semantic context from session-init',
      },
    }));
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'timeline context from context handler',
      },
    }));

    try {
      const result = await handler.execute(input);

      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.additionalContext).toBe(
        'semantic context from session-init\n\ntimeline context from context handler'
      );
      expect(result.hookSpecificOutput!.hookEventName).toBe('SessionStart');
    } finally {
      sessionInitSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });
});

describe('sessionInitContextHandler once-per-session gating (kimi)', () => {
  let dataDir: string;
  const origDataDir = process.env.CLAUDE_MEM_DATA_DIR;

  const plainInitResult = {
    continue: true as const,
    suppressOutput: true as const,
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kimi-gate-handler-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function kimiInput(sessionId: string): NormalizedHookInput {
    return { sessionId, cwd: process.cwd(), platform: 'kimi' };
  }

  it('injects context on the first prompt of a session and writes the marker', async () => {
    const handler = getEventHandler('session-init-context');
    const sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => plainInitResult);
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'timeline' },
    }));

    try {
      const result = await handler.execute(kimiInput('gate-first'));
      expect(contextSpy).toHaveBeenCalledTimes(1);
      expect(result.hookSpecificOutput?.additionalContext).toBe('timeline');
      expect(hasInjected('gate-first')).toBe(true);
    } finally {
      sessionInitSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });

  it('skips the context fetch on later prompts of the same session', async () => {
    const handler = getEventHandler('session-init-context');
    markInjected('gate-repeat');
    const sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => plainInitResult);
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => {
      throw new Error('contextHandler MUST NOT run once the session marker exists');
    });

    try {
      const result = await handler.execute(kimiInput('gate-repeat'));
      expect(contextSpy).not.toHaveBeenCalled();
      // session-init still ran (prompt tracking continues every prompt)
      expect(sessionInitSpy).toHaveBeenCalledTimes(1);
      // nothing appended to the model context
      expect(result.hookSpecificOutput?.additionalContext ?? '').toBe('');
    } finally {
      sessionInitSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });

  it('does not write the marker when the context fetch produced nothing', async () => {
    const handler = getEventHandler('session-init-context');
    const sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => plainInitResult);
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: 0,
    }));

    try {
      await handler.execute(kimiInput('gate-empty'));
      expect(contextSpy).toHaveBeenCalledTimes(1);
      expect(hasInjected('gate-empty')).toBe(false);
    } finally {
      sessionInitSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });

  it('still merges semantic context through on a gated (repeat) prompt', async () => {
    const handler = getEventHandler('session-init-context');
    markInjected('gate-semantic');
    const sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'semantic hits for this prompt',
      },
    }));
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => {
      throw new Error('contextHandler MUST NOT run once the session marker exists');
    });

    try {
      const result = await handler.execute(kimiInput('gate-semantic'));
      expect(result.hookSpecificOutput?.additionalContext).toBe('semantic hits for this prompt');
    } finally {
      sessionInitSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });
});

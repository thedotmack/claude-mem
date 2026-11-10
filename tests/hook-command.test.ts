import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import {
  buildNoOpResult,
  hookCommand,
  isNonBlockingHookInputError,
  isWorkerUnavailableError,
} from '../src/cli/hook-command.js';
import { claudeCodeAdapter } from '../src/cli/adapters/claude-code.js';
import { getEventHandler } from '../src/cli/handlers/index.js';
import { HOOK_EXIT_CODES } from '../src/shared/hook-constants.js';
import { getActiveHookType, setActiveHookType } from '../src/shared/worker-utils.js';
import { SAFETY_TIMEOUT_MS } from '../src/cli/stdin-reader.js';
import { HookStdoutError } from '../src/shared/hook-io.js';
import * as spoolHookEventModule from '../src/cli/spool-hook-event.js';
import { installFakeStdin, installOpenFakeStdin, restoreStdin } from './fake-stdin.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { resetHookSettingsCacheForTesting } from '../src/shared/hook-settings.js';

const realStdoutWrite = process.stdout.write;

function captureStdout(chunks: string[] = []): void {
  process.stdout.write = ((chunk: string, callback: () => void): boolean => {
    chunks.push(String(chunk).replace(/\n$/, ''));
    callback();
    return true;
  }) as typeof process.stdout.write;
}

afterEach(() => {
  restoreStdin();
  process.stdout.write = realStdoutWrite;
  setActiveHookType('');
  resetHookSettingsCacheForTesting();
});

describe('hook_failed telemetry type', () => {
  it('classifies SessionEnd as a closed hook_type value', () => {
    setActiveHookType('session-end');

    expect(getActiveHookType()).toBe('session-end');
  });
});

describe('buildNoOpResult', () => {
  it('attaches a valid SessionStart hookSpecificOutput for the context event (#2972)', () => {
    const result = buildNoOpResult('context');

    expect(result).toEqual({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    });
  });

  it('omits hookSpecificOutput for every other event', () => {
    for (const event of ['session-init', 'observation', 'summarize', 'user-message', 'file-edit', 'file-context']) {
      expect(buildNoOpResult(event)).toEqual({ continue: true, suppressOutput: true });
    }
  });
});

describe('hookCommand tool-hook disable (#3106)', () => {
  afterEach(() => {
    delete process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS;
    delete process.env.CLAUDE_MEM_DISABLE_OBSERVATION;
    delete process.env.CLAUDE_MEM_DISABLE_FILE_CONTEXT;
  });

  it('exits success without reading stdin when CLAUDE_MEM_DISABLE_TOOL_HOOKS=1', async () => {
    process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS = '1';
    // No stdin JSON is provided; a disabled early-return must not hang on readJsonFromStdin.
    const code = await hookCommand('claude-code', 'observation', { skipExit: true });
    expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('also no-ops file-context when CLAUDE_MEM_DISABLE_TOOL_HOOKS=1', async () => {
    process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS = '1';
    const code = await hookCommand('claude-code', 'file-context', { skipExit: true });
    expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('exits before reading stdin when observer capture is disabled in settings', async () => {
    const stderr: string[] = [];
    const realStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => {
      process.stderr.write('settings migration warning\n');
      return {
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_OBSERVER_ENABLED: 'false',
      };
    });
    try {
      // No stdin JSON: reaching the normal pipeline would hang or time out.
      const code = await hookCommand('claude-code', 'observation', { skipExit: true });
      expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
      expect(stderr).toEqual([]);
    } finally {
      settings.mockRestore();
      process.stderr.write = realStderrWrite;
    }
  });
});

describe('isNonBlockingHookInputError', () => {
  it('classifies missing transcript paths as non-blocking hook input errors', () => {
    const error = new Error(
      'Transcript path missing or file does not exist: /tmp/missing-session.jsonl'
    );

    expect(isNonBlockingHookInputError(error)).toBe(true);
  });

  it('classifies missing transcript-path errors without file-existence text', () => {
    expect(
      isNonBlockingHookInputError(new Error('Transcript path missing: /tmp/missing-session.jsonl'))
    ).toBe(true);
  });

  it('classifies nonexistent transcript-path errors without missing text', () => {
    expect(
      isNonBlockingHookInputError(new Error('Transcript path does not exist: /tmp/missing-session.jsonl'))
    ).toBe(true);
  });

  it('does not classify unrelated hook errors as non-blocking input errors', () => {
    expect(isNonBlockingHookInputError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isNonBlockingHookInputError(new Error('Request failed: 400'))).toBe(false);
  });

  it('fails open through hookCommand for truncated stdin and emits one no-op envelope', async () => {
    installFakeStdin('{"session_id":');
    const output: string[] = [];
    captureStdout(output);

    const exitCode = await hookCommand('claude-code', 'context', { skipExit: true });

    expect(exitCode).toBe(0);
    expect(output).toEqual([
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      }),
    ]);
  });

  it('fails open through hookCommand for the UserPromptSubmit session-init hook and emits one empty envelope', async () => {
    installFakeStdin('{"session_id":');
    const output: string[] = [];
    captureStdout(output);

    const exitCode = await hookCommand('claude-code', 'session-init', { skipExit: true });

    expect(exitCode).toBe(0);
    expect(output).toEqual(['{}']);
  });

  it('fails open through hookCommand when stdin reaches the incomplete timeout path', async () => {
    installOpenFakeStdin('{"session_id":');
    const output: string[] = [];
    captureStdout(output);

    const exitCode = await hookCommand('claude-code', 'session-init', {
      skipExit: true,
      stdinSafetyTimeoutMs: 1,
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual(['{}']);
  });

  it('classifies incomplete stdin timeout diagnostics as non-blocking', () => {
    expect(isNonBlockingHookInputError(new Error(`Incomplete JSON after ${SAFETY_TIMEOUT_MS}ms: {"session_id":...`))).toBe(true);
  });

  it('keeps unrelated errors with a reader phrase blocking', () => {
    expect(isNonBlockingHookInputError(new Error('Handler failed: Malformed JSON at stdin EOF: {"session_id":...'))).toBe(false);
  });
});

describe('hookCommand catch-all never blocks (#3161, plan-17 step 2)', () => {
  const originalTelemetry = process.env.CLAUDE_MEM_TELEMETRY;

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.CLAUDE_MEM_TELEMETRY;
    else process.env.CLAUDE_MEM_TELEMETRY = originalTelemetry;
  });

  // Exit 2 used to answer these: UserPromptSubmit dropped the prompt,
  // PreToolUse denied the tool, and Stop re-woke the agent in a loop.
  for (const event of ['context', 'session-init', 'observation', 'file-context', 'summarize', 'session-end']) {
    it(`answers an unexpected ${event} handler error with the no-op envelope and exit 0`, async () => {
      // The catch-all awaits hook_failed telemetry; keep it off the network.
      process.env.CLAUDE_MEM_TELEMETRY = '0';
      const executeSpy = spyOn(getEventHandler(event), 'execute').mockImplementation(async () => {
        throw new TypeError('unexpected handler bug');
      });
      const stdout: string[] = [];
      captureStdout(stdout);
      const stderr: string[] = [];
      const realStderrWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as typeof process.stderr.write;
      installFakeStdin(JSON.stringify({ session_id: 'catch-all-session', cwd: process.cwd() }));

      try {
        const exitCode = await hookCommand('claude-code', event, { skipExit: true });

        expect(exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(stdout).toEqual([JSON.stringify(claudeCodeAdapter.formatOutput(buildNoOpResult(event)))]);
        expect(stderr.join('')).toContain('claude-mem: hook error, continuing without memory: unexpected handler bug');
      } finally {
        process.stderr.write = realStderrWrite;
        executeSpy.mockRestore();
      }
    });
  }
});

describe('hookCommand stdout delivery failures', () => {
  it('rejects a failed write without emitting a second envelope', async () => {
    const executeSpy = spyOn(getEventHandler('session-init'), 'execute').mockResolvedValue({ continue: true });
    const output: string[] = [];
    process.stdout.write = ((chunk: string, callback: (error?: Error | null) => void): boolean => {
      output.push(String(chunk));
      queueMicrotask(() => callback(new Error('stdout unavailable')));
      return false;
    }) as typeof process.stdout.write;
    installFakeStdin(JSON.stringify({ session_id: 'stdout-failure', cwd: process.cwd() }));
    try {
      await expect(hookCommand('claude-code', 'session-init', { skipExit: true })).rejects.toBeInstanceOf(HookStdoutError);
      expect(output).toEqual(['{}\n']);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('hookCommand stdout failure while capture handoffs settle', () => {
  it('reports the closed stdout as a handled delivery error, never an unhandled rejection', async () => {
    const executeSpy = spyOn(getEventHandler('session-init'), 'execute').mockResolvedValue({ continue: true });
    // The handoff wait outlives the failed write, so an un-awaited stdout promise would reject with no handler.
    const settleSpy = spyOn(spoolHookEventModule, 'settleHookSpoolNudges').mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', recordUnhandledRejection);
    process.stdout.write = ((_chunk: string, callback: (error?: Error | null) => void): boolean => {
      setTimeout(() => callback(new Error('write EPIPE')), 0);
      return false;
    }) as typeof process.stdout.write;
    installFakeStdin(JSON.stringify({ session_id: 'stdout-closed-during-handoff', cwd: process.cwd() }));
    try {
      await expect(hookCommand('claude-code', 'session-init', { skipExit: true })).rejects.toBeInstanceOf(HookStdoutError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandledRejection);
      settleSpy.mockRestore();
      executeSpy.mockRestore();
    }
  });
});

describe("hook claude <event> is Claude Code (#2835)", () => {
  it('hands handlers the canonical platform id, so claude-code branches apply', async () => {
    const platforms: unknown[] = [];
    const executeSpy = spyOn(getEventHandler('session-init'), 'execute').mockImplementation(async (input) => {
      platforms.push(input.platform);
      return { continue: true, suppressOutput: true };
    });
    captureStdout();
    installFakeStdin(JSON.stringify({ session_id: 'alias-session', cwd: process.cwd(), prompt: 'hello' }));

    try {
      const exitCode = await hookCommand('claude', 'session-init', { skipExit: true });

      expect(exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
      expect(platforms).toEqual(['claude-code']);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('isWorkerUnavailableError', () => {
  it.each([
    [new Error('connect ECONNREFUSED 127.0.0.1:37777'), true],
    [new Error('socket hang up ECONNRESET'), true],
    [new Error('write EPIPE'), true],
    [new Error('connect ETIMEDOUT 127.0.0.1:37777'), true],
    [new TypeError('fetch failed'), true],
    [new Error('Unable to connect to server'), true],
    [new Error('getaddrinfo ENOTFOUND localhost'), true],
    [new Error('socket hang up'), true],
    [new Error('The socket connection was closed unexpectedly'), true],
    [new Error('connection closed'), true],
    [new Error('ECONNABORTED'), true],
    [new Error('Request timed out after 3000ms'), true],
    [new Error('Connection timeout'), true],
    [new Error('Context generation failed: 500'), true],
    [new Error('Observation storage failed: 502'), true],
    [new Error('Request failed: 503'), true],
    [new Error('HTTP error status: 500'), true],
    [new Error('Request failed: 429'), true],
    [new Error('HTTP error status: 429'), true],
    [new Error('Request failed: 400'), false],
    [new Error('Observation storage failed: 404'), false],
    [new Error('Request failed: 422'), false],
    [new Error('HTTP error status: 400'), false],
    [new TypeError('Cannot read properties of undefined'), false],
    [new ReferenceError('foo is not defined'), false],
    [new SyntaxError('Unexpected token'), false],
    [new Error('Something unexpected happened'), false],
    ['ECONNREFUSED', true],
    ['random error', false],
    [null, false],
    [undefined, false],
  ].map(([error, expected]) => [
    error instanceof Error ? `${error.name}: ${error.message}` : String(error), error, expected,
  ] as const))('classifies %s as unavailable=%p', (_label, error, expected) => {
    expect(isWorkerUnavailableError(error)).toBe(expected);
  });
});

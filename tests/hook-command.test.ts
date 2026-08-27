import { describe, it, expect, afterEach } from 'bun:test';
import { Readable } from 'stream';
import { buildNoOpResult, hookCommand, isNonBlockingHookInputError, isWorkerUnavailableError, NON_BLOCKING_TELEMETRY_DEADLINE_MS, raceDeadline } from '../src/cli/hook-command.js';
import { HookInputUnreadable } from '../src/cli/stdin-reader.js';
import { HOOK_EXIT_CODES } from '../src/shared/hook-constants.js';

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

  // #3699: stdin that never arrives as parseable JSON is an input failure,
  // not a handler bug — the hook has nothing to work with and must fail open.
  it('classifies unreadable stdin as a non-blocking hook input error', () => {
    expect(isNonBlockingHookInputError(new HookInputUnreadable('Malformed JSON at stdin EOF: {...'))).toBe(true);
    expect(isNonBlockingHookInputError(new HookInputUnreadable('Incomplete JSON after 30000ms: {...'))).toBe(true);
  });

  // A plain Error carrying the same text is NOT the signal — only the type is.
  it('does not classify a look-alike message from an untyped throw', () => {
    expect(isNonBlockingHookInputError(new Error('Malformed JSON at stdin EOF: {...'))).toBe(false);
  });
});

describe('isWorkerUnavailableError', () => {
  describe('transport failures → true (graceful)', () => {
    it('should classify ECONNREFUSED as worker unavailable', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:37777');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ECONNRESET as worker unavailable', () => {
      const error = new Error('socket hang up ECONNRESET');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify EPIPE as worker unavailable', () => {
      const error = new Error('write EPIPE');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ETIMEDOUT as worker unavailable', () => {
      const error = new Error('connect ETIMEDOUT 127.0.0.1:37777');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "fetch failed" as worker unavailable', () => {
      const error = new TypeError('fetch failed');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "Unable to connect" as worker unavailable', () => {
      const error = new Error('Unable to connect to server');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ENOTFOUND as worker unavailable', () => {
      const error = new Error('getaddrinfo ENOTFOUND localhost');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "socket hang up" as worker unavailable', () => {
      const error = new Error('socket hang up');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ECONNABORTED as worker unavailable', () => {
      const error = new Error('ECONNABORTED');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('timeout errors → true (graceful)', () => {
    it('should classify "timed out" as worker unavailable', () => {
      const error = new Error('Request timed out after 3000ms');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "timeout" as worker unavailable', () => {
      const error = new Error('Connection timeout');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('HTTP 5xx server errors → true (graceful)', () => {
    it('should classify 500 status as worker unavailable', () => {
      const error = new Error('Context generation failed: 500');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify 502 status as worker unavailable', () => {
      const error = new Error('Observation storage failed: 502');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify 503 status as worker unavailable', () => {
      const error = new Error('Request failed: 503');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "status: 500" format as worker unavailable', () => {
      const error = new Error('HTTP error status: 500');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('HTTP 429 rate limit → true (graceful)', () => {
    it('should classify 429 as worker unavailable (rate limit is transient)', () => {
      const error = new Error('Request failed: 429');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "status: 429" format as worker unavailable', () => {
      const error = new Error('HTTP error status: 429');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('HTTP 4xx client errors → false (blocking)', () => {
    it('should NOT classify 400 Bad Request as worker unavailable', () => {
      const error = new Error('Request failed: 400');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify 404 Not Found as worker unavailable', () => {
      const error = new Error('Observation storage failed: 404');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify 422 Validation Error as worker unavailable', () => {
      const error = new Error('Request failed: 422');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify "status: 400" format as worker unavailable', () => {
      const error = new Error('HTTP error status: 400');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });
  });

  describe('programming errors → false (blocking)', () => {
    it('should NOT classify TypeError as worker unavailable', () => {
      const error = new TypeError('Cannot read properties of undefined');
      expect(isWorkerUnavailableError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    });

    it('should NOT classify ReferenceError as worker unavailable', () => {
      const error = new ReferenceError('foo is not defined');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify SyntaxError as worker unavailable', () => {
      const error = new SyntaxError('Unexpected token');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });
  });

  describe('unknown errors → false (blocking, conservative)', () => {
    it('should NOT classify generic Error as worker unavailable', () => {
      const error = new Error('Something unexpected happened');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should handle string errors', () => {
      expect(isWorkerUnavailableError('ECONNREFUSED')).toBe(true);
      expect(isWorkerUnavailableError('random error')).toBe(false);
    });

    it('should handle null/undefined errors', () => {
      expect(isWorkerUnavailableError(null)).toBe(false);
      expect(isWorkerUnavailableError(undefined)).toBe(false);
    });
  });
});

/**
 * #3699 — the hook must not exit 2 when it cannot read its own stdin.
 *
 * In plugin/hooks/hooks.json, PostToolUse / PreToolUse / Stop all carry
 * `"async": true`, so Claude Code backgrounds them and synthesises status 0.
 * UserPromptSubmit (session-init) and SessionStart (context) do NOT, so their
 * real exit code is read — and on UserPromptSubmit an exit of 2 blocks the
 * submission and discards what the user typed.
 *
 * Driving hookCommand end to end (rather than the predicate alone) is what
 * makes these regression tests: stdin is rejected before any handler runs, so
 * no worker is contacted and the assertion is purely about the exit contract.
 */
describe('hookCommand exit contract on unreadable stdin (#3699)', () => {
  const realStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

  function installFakeStdin(payload: string): void {
    const fake = Readable.from([payload], { objectMode: false }) as unknown as NodeJS.ReadStream;
    Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process, 'stdin', { configurable: true, writable: true, value: fake });
  }

  afterEach(() => {
    if (realStdinDescriptor) {
      Object.defineProperty(process, 'stdin', realStdinDescriptor);
    }
  });

  // The synchronously-registered hooks — the ones where exit 2 reaches the
  // harness and costs the user something.
  for (const event of ['session-init', 'context']) {
    it(`exits 0 on truncated stdin for the ${event} hook`, async () => {
      installFakeStdin('{"session_id":"s","cwd":"/tmp"');
      const code = await hookCommand('claude-code', event, { skipExit: true });
      expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
    });

    it(`exits 0 on stdin that is not JSON at all for the ${event} hook`, async () => {
      installFakeStdin('not json at all');
      const code = await hookCommand('claude-code', event, { skipExit: true });
      expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
    });
  }
});

/**
 * Review on #3699 — the fail-open path must not be held by its own telemetry.
 *
 * The branch exists so a hook that cannot read stdin costs the user nothing.
 * Awaiting an optional POST reintroduced that cost: with telemetry enabled and
 * an endpoint that accepts but never answers, the no-op response was delayed by
 * seconds on a synchronously-registered hook.
 */
describe('fail-open telemetry is on a deadline (#3699 review)', () => {
  const realStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

  function installFakeStdin(payload: string): void {
    const fake = Readable.from([payload], { objectMode: false }) as unknown as NodeJS.ReadStream;
    Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process, 'stdin', { configurable: true, writable: true, value: fake });
  }

  afterEach(() => {
    if (realStdinDescriptor) {
      Object.defineProperty(process, 'stdin', realStdinDescriptor);
    }
  });

  it('keeps the deadline short enough to be invisible on a synchronous hook', () => {
    // UserPromptSubmit and SessionStart are read for their real exit status,
    // so this budget is time the user spends waiting.
    expect(NON_BLOCKING_TELEMETRY_DEADLINE_MS).toBeLessThanOrEqual(500);
  });

  // Driving hookCommand would NOT prove this: telemetry consent is off under
  // test, so captureCliEvent returns immediately and the branch is fast either
  // way. The mechanism is what has to be pinned.
  it('gives up on a POST that never answers', async () => {
    const neverSettles = new Promise<void>(() => {});

    const startedAt = Date.now();
    await raceDeadline(neverSettles, 50);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1_000);
  });

  it('does not delay a POST that answers before the deadline', async () => {
    const startedAt = Date.now();
    await raceDeadline(Promise.resolve('sent'), 5_000);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
  });

  it('still exits 0 on truncated stdin with the deadline in place', async () => {
    installFakeStdin('{"session_id":"s","cwd":"/tmp"');

    const code = await hookCommand('claude-code', 'session-init', { skipExit: true });

    expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
  });
});

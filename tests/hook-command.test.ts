import { describe, it, expect, mock, spyOn } from 'bun:test';
import { buildNoOpResult, hookCommand, isNonBlockingHookInputError, isWorkerUnavailableError } from '../src/cli/hook-command.js';

describe('worker-unavailable hook preflight', () => {
  it('emits the worker-unavailable no-op for a real context hook without touching stdin or worker APIs', async () => {
    const originalWrite = process.stderr.write;
    const originalFetch = global.fetch;
    const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(process.stdin, 'isTTY');
    const originalOwnIsTTY = hadOwnIsTTY ? (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY : undefined;
    const writes: string[] = [];
    const stdout: string[] = [];
    const consoleLogSpy = spyOn(console, 'log').mockImplementation((line?: unknown) => {
      stdout.push(String(line));
    });
    const stdinOnSpy = spyOn(process.stdin, 'on').mockImplementation(((event: string, listener: (...args: any[]) => void) => {
      if (event === 'end') queueMicrotask(listener);
      return process.stdin;
    }) as typeof process.stdin.on);
    const fetchMock = mock(() => Promise.reject(new Error('unexpected worker API call')));
    global.fetch = fetchMock as typeof global.fetch;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      expect(await hookCommand('raw', 'context', { skipExit: true, workerUnavailable: true })).toBe(0);
      expect(stdout).toEqual([JSON.stringify(buildNoOpResult('context'))]);
      expect(stdinOnSpy.mock.calls).toHaveLength(0);
      expect(fetchMock.mock.calls).toHaveLength(0);
      process.stderr.write('after-hook\n');
      expect(writes).toEqual(['after-hook\n']);
    } finally {
      if (hadOwnIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalOwnIsTTY });
      } else {
        delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      }
      global.fetch = originalFetch;
      process.stderr.write = originalWrite;
      stdinOnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
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

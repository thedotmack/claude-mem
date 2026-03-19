import { describe, it, expect, mock, beforeEach } from 'bun:test';

let mockHandler: any;

mock.module('../../src/cli/stdin-reader.js', () => ({
  readJsonFromStdin: () => Promise.resolve({ sessionId: 'test-session', query: 'test' }),
}));

mock.module('../../src/cli/adapters/index.js', () => ({
  getPlatformAdapter: () => ({
    normalizeInput: (raw: any) => ({ ...raw, platform: 'claude-code' }),
    formatOutput: (result: any) => result,
  }),
}));

mock.module('../../src/cli/handlers/index.js', () => ({
  getEventHandler: () => mockHandler,
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

const { hookCommand } = await import('../../src/cli/hook-command.js');
const { HOOK_EXIT_CODES } = await import('../../src/shared/hook-constants.js');

describe('hookCommand catch block: stop events vs other events', () => {
  beforeEach(() => {
    mockHandler = undefined;
  });

  it('stop event (summarize) + SyntaxError returns FAILURE (1)', async () => {
    mockHandler = {
      execute: () => {
        throw new SyntaxError('bad json');
      },
    };

    const exitCode = await hookCommand('claude-code', 'summarize', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.FAILURE);
    expect(exitCode).toBe(1);
  });

  it('stop event (session-complete) + generic Error returns FAILURE (1)', async () => {
    mockHandler = {
      execute: () => {
        throw new Error('some bug');
      },
    };

    const exitCode = await hookCommand('claude-code', 'session-complete', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.FAILURE);
    expect(exitCode).toBe(1);
  });

  it('stop event + worker unavailable (ECONNREFUSED) returns SUCCESS (0)', async () => {
    mockHandler = {
      execute: () => {
        throw new Error('ECONNREFUSED');
      },
    };

    const exitCode = await hookCommand('claude-code', 'summarize', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(exitCode).toBe(0);
  });

  it('non-stop event (observation) + SyntaxError returns BLOCKING_ERROR (2)', async () => {
    mockHandler = {
      execute: () => {
        throw new SyntaxError('bad json');
      },
    };

    const exitCode = await hookCommand('claude-code', 'observation', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
    expect(exitCode).toBe(2);
  });

  it('non-stop event (context) + generic Error returns BLOCKING_ERROR (2)', async () => {
    mockHandler = {
      execute: () => {
        throw new Error('some bug');
      },
    };

    const exitCode = await hookCommand('claude-code', 'context', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
    expect(exitCode).toBe(2);
  });
});

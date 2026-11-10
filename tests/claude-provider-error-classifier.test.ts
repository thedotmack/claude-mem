import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import {
  classifyClaudeError,
  __resetEffortHintLatchForTesting,
} from '../src/services/worker/ClaudeProvider.js';
import { isClassified } from '../src/services/worker/provider-errors.js';
import { logger } from '../src/utils/logger.js';

/**
 * Tests for HTTP 400 classification in ClaudeProvider's classifyClaudeError.
 *
 * Regression coverage for #2357: ClaudeProvider previously had no explicit
 * HTTP 400 handling, so the default branch classified all 400s as `transient`
 * and the retry loop would hammer a permanent error indefinitely (e.g. when
 * CLAUDE_CODE_EFFORT_LEVEL leaks into the SDK subprocess and the model
 * rejects the `effort` parameter).
 */
describe('classifyClaudeError — HTTP 400 handling (#2357)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetEffortHintLatchForTesting();
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetEffortHintLatchForTesting();
  });

  it('classifies 400 with "effort parameter" body as unrecoverable AND logs an SDK warn once', () => {
    const sdkErr = Object.assign(
      new Error('This model does not support the effort parameter.'),
      { status: 400 },
    );

    const classified = classifyClaudeError(sdkErr);

    expect(isClassified(classified)).toBe(true);
    expect(classified.kind).toBe('unrecoverable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // First positional arg of logger.warn is the component category.
    const [component, hintMessage] = warnSpy.mock.calls[0] as [string, string, ...unknown[]];
    expect(component).toBe('SDK');
    expect(hintMessage).toMatch(/effort/i);
    expect(hintMessage).toMatch(/2357/);
  });

  it('classifies 400 with effort marker in a structured body field', () => {
    const sdkErr = Object.assign(
      new Error('Bad request'),
      {
        status: 400,
        body: { error: { message: 'This model does not support the effort parameter.' } },
      },
    );

    const classified = classifyClaudeError(sdkErr);

    expect(classified.kind).toBe('unrecoverable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies 400 without effort body as unrecoverable WITHOUT firing the effort hint', () => {
    const sdkErr = Object.assign(
      new Error('some other 400 error'),
      { status: 400 },
    );

    const classified = classifyClaudeError(sdkErr);

    expect(classified.kind).toBe('unrecoverable');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throttles the effort hint to one log per process even on repeated 400s', () => {
    const sdkErr = Object.assign(
      new Error('This model does not support the effort parameter.'),
      { status: 400 },
    );

    for (let i = 0; i < 5; i++) {
      const classified = classifyClaudeError(sdkErr);
      expect(classified.kind).toBe('unrecoverable');
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

const wrappedCreditError =
  'API Error: 400 {"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

describe('classifyClaudeError — status and message classification', () => {
  it.each([
    [new Error('ECONNRESET: socket hang up'), 'transient'],
    [new Error('The provided model identifier is invalid'), 'unrecoverable'],
    [Object.assign(new Error('Anthropic SDK error'), { error: { type: 'invalid_request_error' } }), 'unrecoverable'],
    [new Error('Request failed: invalid_request_error from upstream'), 'unrecoverable'],
    [new Error('Some unrelated invalid input from a tool'), 'transient'],
    [Object.assign(new Error('gateway error: invalid_request_error from upstream'), {
      status: 503, error: { type: 'invalid_request_error' },
    }), 'transient'],
    [new Error('Observer working directory could not be prepared: /home/u/data/observer-sessions (ENOTDIR): not a directory'), 'setup_required'],
    [new Error('Claude Code returned an error result: Path "/home/u/.claude-mem/observer-sessions/1" does not exist'), 'transient'],
    [new Error('upstream said: Observer working directory could not be prepared: /x (EACCES): denied'), 'transient'],
    [new Error('the requested record does not exist'), 'transient'],
    [new Error(wrappedCreditError), 'quota_exhausted'],
    [Object.assign(new Error(wrappedCreditError), { status: 400 }), 'quota_exhausted'],
    [Object.assign(new Error('Bad request'), {
      status: 400,
      body: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    }), 'quota_exhausted'],
    [new Error('Claude Code returned an error result: Credit balance is too low'), 'quota_exhausted'],
    [new Error('API Error: 400 {"error":{"type":"invalid_request_error","message":"max_tokens: too large"}}'), 'unrecoverable'],
  ])('%s → %s', (error, kind) => {
    expect(classifyClaudeError(error).kind).toBe(kind);
  });

  it('routes statused model rejections through the 400 branch without an effort hint', () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const error = Object.assign(new Error('The provided model identifier is invalid'), { status: 400 });
      expect(classifyClaudeError(error).kind).toBe('unrecoverable');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

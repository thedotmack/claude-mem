import { describe, it, expect } from 'bun:test';
import {
  ClassifiedProviderError,
  isClassified,
} from '../../src/services/worker/provider-errors.js';
import { classifyClaudeError } from '../../src/services/worker/ClaudeProvider.js';
import {
  categorizeGeminiBadRequest,
  classifyGeminiError,
} from '../../src/services/worker/GeminiProvider.js';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';

// Hard cases per F4 spec — provider-specific classifiers must map raw HTTP
// shapes / SDK errors to ClassifiedProviderError with the right kind.

describe('classifyGeminiError', () => {
  for (const [category, bodyText] of [
    ['role_sequence', 'Please ensure that multiturn requests alternate between user and model.'],
    ['context_limit', 'Request contains 120000 tokens which exceeds the maximum token limit.'],
    ['model_unsupported', 'Model gemini-example is not supported for generateContent.'],
    ['api_key', 'API_KEY_INVALID: API key not valid.'],
    ['unknown_bad_request', 'Invalid JSON payload received. Unknown name "foo".'],
  ] as const) {
    it(`categorizes Gemini 400 bad request body as ${category}`, () => {
      expect(categorizeGeminiBadRequest(bodyText)).toBe(category);
    });
  }

  it('classifies 429 with no Retry-After as rate_limit with no retryAfterMs', () => {
    const headers = new Headers(); // no Retry-After
    const cause = new Error('Gemini API error: 429 - quota');
    const err = classifyGeminiError({
      status: 429,
      bodyText: 'Too Many Requests',
      headers,
      cause,
    });
    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('status 429');
    expect((err.cause as Error).message).not.toContain('quota');
  });

  it('classifies 429 with Retry-After: 5 as rate_limit with retryAfterMs=5000', () => {
    const headers = new Headers({ 'Retry-After': '5' });
    const err = classifyGeminiError({
      status: 429,
      bodyText: '',
      headers,
      cause: new Error('rate limited'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(5000);
  });

  it('classifies 500 with body containing "quota exceeded" as quota_exhausted', () => {
    const err = classifyGeminiError({
      status: 500,
      bodyText: 'Internal: quota exceeded for model',
      cause: new Error('500 - quota exceeded'),
    });
    expect(err.kind).toBe('quota_exhausted');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('classifies 401 with "API key not valid" body as auth_invalid', () => {
    const err = classifyGeminiError({
      status: 401,
      bodyText: 'API key not valid. Please pass a valid API key.',
      cause: new Error('401'),
    });
    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies 403 PERMISSION_DENIED as auth_invalid', () => {
    const err = classifyGeminiError({
      status: 403,
      bodyText: 'PERMISSION_DENIED',
      cause: new Error('403'),
    });
    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies 503 as transient', () => {
    const err = classifyGeminiError({
      status: 503,
      bodyText: 'service unavailable',
      cause: new Error('503'),
    });
    expect(err.kind).toBe('transient');
  });

  it('classifies network error (no status) as transient', () => {
    const cause = new Error('fetch failed: ECONNREFUSED');
    const err = classifyGeminiError({ cause });
    expect(err.kind).toBe('transient');
    expect(err.cause).toBe(cause);
  });

  it('classifies 400 as unrecoverable with a stable category message', () => {
    const rawBody = 'Please ensure that multiturn requests alternate between user and model. RAW_PROVIDER_BODY';
    const cause = new Error(`400 - ${rawBody}`);
    const err = classifyGeminiError({
      status: 400,
      bodyText: rawBody,
      cause,
    });
    expect(err.kind).toBe('unrecoverable');
    expect(err.message).toBe('Gemini bad request: role_sequence');
    expect(err.message).not.toContain('RAW_PROVIDER_BODY');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('status 400');
    expect((err.cause as Error).message).not.toContain('RAW_PROVIDER_BODY');
  });

  it('redacts non-400 fallback response bodies from message and cause', () => {
    const rawBody = 'RAW_PROVIDER_BODY with credential sk-secret';
    const err = classifyGeminiError({
      status: 418,
      bodyText: rawBody,
      cause: new Error(`Gemini API error: 418 - ${rawBody}`),
      requestId: 'gemini-request-1',
    });
    expect(err.kind).toBe('unrecoverable');
    expect(err.message).toBe('Gemini API error (status 418)');
    expect(err.message).not.toContain(rawBody);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('status 418');
    expect((err.cause as Error).message).toContain('gemini-request-1');
    expect((err.cause as Error).message).not.toContain(rawBody);
  });
});

describe('classifyOpenRouterError', () => {
  it('classifies 429 with no Retry-After as rate_limit with no retryAfterMs', () => {
    const headers = new Headers(); // no Retry-After
    const err = classifyOpenRouterError({
      status: 429,
      bodyText: 'rate limit exceeded',
      headers,
      cause: new Error('429'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('classifies 429 with Retry-After: 10 as rate_limit with retryAfterMs=10000', () => {
    const headers = new Headers({ 'retry-after': '10' });
    const err = classifyOpenRouterError({
      status: 429,
      bodyText: '',
      headers,
      cause: new Error('429'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(10_000);
  });

  it('classifies 500 with body containing "quota exceeded" as quota_exhausted', () => {
    const err = classifyOpenRouterError({
      status: 500,
      bodyText: 'something quota exceeded',
      cause: new Error('500'),
    });
    expect(err.kind).toBe('quota_exhausted');
  });

  it('classifies "insufficient credits" body as quota_exhausted regardless of status', () => {
    const err = classifyOpenRouterError({
      status: 402,
      bodyText: 'insufficient credits',
      cause: new Error('402'),
    });
    expect(err.kind).toBe('quota_exhausted');
  });

  it('classifies 401 as auth_invalid', () => {
    const err = classifyOpenRouterError({
      status: 401,
      bodyText: 'unauthorized',
      cause: new Error('401'),
    });
    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies 502 as transient', () => {
    const err = classifyOpenRouterError({
      status: 502,
      bodyText: 'bad gateway',
      cause: new Error('502'),
    });
    expect(err.kind).toBe('transient');
  });

  it('classifies network error (no status) as transient', () => {
    const cause = new Error('ECONNRESET');
    const err = classifyOpenRouterError({ cause });
    expect(err.kind).toBe('transient');
  });
});

describe('classifyClaudeError', () => {
  it('classifies SDK-level OverloadedError as transient', () => {
    class OverloadedError extends Error {
      constructor() {
        super('Overloaded');
        this.name = 'OverloadedError';
      }
    }
    const err = classifyClaudeError(new OverloadedError());
    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('transient');
  });

  it('classifies 529 status as transient', () => {
    const sdkErr = Object.assign(new Error('overloaded'), { status: 529 });
    const err = classifyClaudeError(sdkErr);
    expect(err.kind).toBe('transient');
  });

  it('classifies anthropic error.type=overloaded_error as transient', () => {
    const sdkErr = Object.assign(new Error('upstream'), {
      error: { type: 'overloaded_error' },
    });
    const err = classifyClaudeError(sdkErr);
    expect(err.kind).toBe('transient');
  });

  it('classifies "Invalid API key" message as auth_invalid', () => {
    const err = classifyClaudeError(new Error('Invalid API key: configure ~/.claude-mem/.env'));
    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies status=401 as auth_invalid', () => {
    const sdkErr = Object.assign(new Error('unauthorized'), { status: 401 });
    const err = classifyClaudeError(sdkErr);
    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies ENOENT spawn error as setup_required', () => {
    const spawnErr = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const err = classifyClaudeError(spawnErr);
    expect(err.kind).toBe('setup_required');
  });

  it('classifies "Claude executable not found" as setup_required', () => {
    const err = classifyClaudeError(new Error('Claude executable not found at $CLAUDE_CODE_PATH'));
    expect(err.kind).toBe('setup_required');
  });

  it('classifies too-old Claude CLI finder errors as setup_required', () => {
    const err = classifyClaudeError(
      new Error(
        'Every Claude CLI found is too old for claude-mem (each rejects flags the memory agent passes on every spawn)'
      )
    );
    expect(err.kind).toBe('setup_required');
  });

  it('classifies desktop app headless-mode setup error as setup_required', () => {
    const err = classifyClaudeError(
      new Error(
        'Found desktop app at "/Applications/Claude.app" but it doesn\'t support headless mode. Install Claude Code CLI: npm install -g @anthropic-ai/claude-code'
      )
    );
    expect(err.kind).toBe('setup_required');
  });

  it('classifies prompt-too-long as unrecoverable', () => {
    const err = classifyClaudeError(new Error('Claude session context overflow: prompt is too long'));
    expect(err.kind).toBe('unrecoverable');
  });

  it('classifies structured context-window errors as unrecoverable', () => {
    const err = classifyClaudeError(new Error('Claude SDK error: context window exceeded'));
    expect(err.kind).toBe('unrecoverable');
  });

  it('classifies status=429 as rate_limit', () => {
    const sdkErr = Object.assign(new Error('rate limited'), { status: 429 });
    const err = classifyClaudeError(sdkErr);
    expect(err.kind).toBe('rate_limit');
  });

  it('classifies "quota exceeded" message as quota_exhausted', () => {
    const err = classifyClaudeError(new Error('upstream: quota exceeded'));
    expect(err.kind).toBe('quota_exhausted');
  });

  it('classifies status=503 as transient', () => {
    const sdkErr = Object.assign(new Error('service unavailable'), { status: 503 });
    const err = classifyClaudeError(sdkErr);
    expect(err.kind).toBe('transient');
  });

  it('classifies unknown error as transient (preserve old default)', () => {
    const err = classifyClaudeError(new Error('something weird happened'));
    expect(err.kind).toBe('transient');
  });
});

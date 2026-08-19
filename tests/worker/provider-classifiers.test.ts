import { describe, it, expect } from 'bun:test';
import {
  ClassifiedProviderError,
  isClassified,
  describeProviderError,
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

  it('classifies a deprecated-model 404 as model_deprecated, not a plain bad request', () => {
    const err = classifyOpenRouterError({
      status: 404,
      bodyText: JSON.stringify({ error: { message: 'This model has been deprecated', code: 404 } }),
      cause: new Error('404'),
    });
    expect(err.kind).toBe('model_deprecated');
  });

  it('still classifies a non-deprecation 404 as unrecoverable', () => {
    const err = classifyOpenRouterError({
      status: 404,
      bodyText: 'No endpoints found for that model',
      cause: new Error('404'),
    });
    expect(err.kind).toBe('unrecoverable');
  });

  // --- Gateway taxonomy envelope: { error: { code, message, action, url, request_id } } ---

  it('carries an allowance_exhausted envelope verbatim as quota_exhausted', () => {
    const message = "You've used your $30 CMEM Pro inference allowance for this billing cycle.";
    const action = 'It resets at the start of your next billing cycle. Need more before then? Email support@cmem.ai.';
    const err = classifyOpenRouterError({
      status: 402,
      bodyText: JSON.stringify({
        error: { code: 'allowance_exhausted', message, action, url: 'https://cmem.ai/dashboard', request_id: 'abc' },
      }),
      cause: new Error('402'),
      requestId: 'header-id',
    });
    expect(err.kind).toBe('quota_exhausted');
    expect(err.code).toBe('allowance_exhausted');
    expect(err.message).toBe(message);
    expect(err.action).toBe(action);
    expect(err.url).toBe('https://cmem.ai/dashboard');
    expect(err.requestId).toBe('abc'); // body request_id wins over the header id
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('maps a key_invalid envelope (401) to auth_invalid', () => {
    const err = classifyOpenRouterError({
      status: 401,
      bodyText: JSON.stringify({
        error: {
          code: 'key_invalid',
          message: "This CMEM Pro key isn't recognized.",
          action: 'Run `npx claude-mem pro-setup` to re-link this machine, or copy a fresh key from your dashboard.',
          url: 'https://cmem.ai/dashboard',
          request_id: 'req-401',
        },
      }),
      cause: new Error('401'),
    });
    expect(err.kind).toBe('auth_invalid');
    expect(err.code).toBe('key_invalid');
    expect(err.message).toBe("This CMEM Pro key isn't recognized.");
    expect(err.action).toContain('npx claude-mem pro-setup');
    expect(err.url).toBe('https://cmem.ai/dashboard');
    expect(err.requestId).toBe('req-401');
  });

  it('maps a subscription_inactive envelope (402) to auth_invalid', () => {
    const err = classifyOpenRouterError({
      status: 402,
      bodyText: JSON.stringify({
        error: {
          code: 'subscription_inactive',
          message: 'Your CMEM Pro subscription has ended.',
          action: 'Resubscribe from the dashboard to turn the observer back on.',
          url: 'https://cmem.ai/dashboard',
          request_id: 'req-sub',
        },
      }),
      cause: new Error('402'),
    });
    expect(err.kind).toBe('auth_invalid');
    expect(err.code).toBe('subscription_inactive');
    expect(err.message).toBe('Your CMEM Pro subscription has ended.');
    expect(err.action).toBe('Resubscribe from the dashboard to turn the observer back on.');
    expect(err.requestId).toBe('req-sub');
  });

  it('maps a rate_limited envelope (429, Retry-After: 60) to rate_limit with retryAfterMs=60000', () => {
    const err = classifyOpenRouterError({
      status: 429,
      bodyText: JSON.stringify({
        error: {
          code: 'rate_limited',
          message: 'Too many observer requests in the last minute.',
          action: 'Retrying automatically in 60s — nothing to do.',
          request_id: 'req-429',
        },
      }),
      headers: new Headers({ 'retry-after': '60' }),
      cause: new Error('429'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(60_000);
    expect(err.message).toBe('Too many observer requests in the last minute.');
    expect(err.action).toBe('Retrying automatically in 60s — nothing to do.');
    expect(err.url).toBeUndefined();
    expect(err.requestId).toBe('req-429');
  });

  it('defaults a rate_limited envelope with no Retry-After header to retryAfterMs=60000', () => {
    const err = classifyOpenRouterError({
      status: 429,
      bodyText: JSON.stringify({ error: { code: 'rate_limited', message: 'Too many.', request_id: 'r' } }),
      cause: new Error('429'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(60_000);
  });

  it('maps an upstream_unavailable envelope (503) to transient', () => {
    const err = classifyOpenRouterError({
      status: 503,
      bodyText: JSON.stringify({
        error: {
          code: 'upstream_unavailable',
          message: 'The observer model is temporarily unavailable.',
          action: 'claude-mem retries automatically. If this lasts more than an hour, email support@cmem.ai with the request id.',
          request_id: 'req-503',
        },
      }),
      cause: new Error('503'),
    });
    expect(err.kind).toBe('transient');
    expect(err.code).toBe('upstream_unavailable');
    expect(err.message).toBe('The observer model is temporarily unavailable.');
    expect(err.action).toContain('email support@cmem.ai');
    expect(err.requestId).toBe('req-503');
  });

  it('maps a bad_request envelope (400) to unrecoverable', () => {
    const err = classifyOpenRouterError({
      status: 400,
      bodyText: JSON.stringify({
        error: {
          code: 'bad_request',
          message: "The observer sent a request the gateway couldn't parse.",
          action: 'This is a claude-mem bug — please open an issue with the request id.',
          url: 'https://github.com/thedotmack/claude-mem/issues',
          request_id: 'req-400',
        },
      }),
      cause: new Error('400'),
    });
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBe('bad_request');
    expect(err.message).toBe("The observer sent a request the gateway couldn't parse.");
    expect(err.action).toBe('This is a claude-mem bug — please open an issue with the request id.');
    expect(err.url).toBe('https://github.com/thedotmack/claude-mem/issues');
    expect(err.requestId).toBe('req-400');
  });

  it('falls back to the header request id when the envelope has no request_id', () => {
    const err = classifyOpenRouterError({
      status: 402,
      bodyText: JSON.stringify({ error: { code: 'allowance_exhausted', message: 'Used up.' } }),
      cause: new Error('402'),
      requestId: 'from-header',
    });
    expect(err.kind).toBe('quota_exhausted');
    expect(err.requestId).toBe('from-header');
    expect(err.action).toBeUndefined();
    expect(err.url).toBeUndefined();
  });

  it('ignores an unknown envelope code and falls through to legacy classification', () => {
    const err = classifyOpenRouterError({
      status: 500,
      bodyText: JSON.stringify({ error: { code: 'something_else', message: 'boom' } }),
      cause: new Error('500'),
    });
    expect(err.kind).toBe('transient');
    expect(err.code).toBeUndefined();
    expect(err.message).toBe('OpenRouter upstream error (status 500): boom');
  });

  // --- Legacy (raw OpenRouter) bodies: keep the upstream message, carry the request id ---

  it('classifies legacy 403 "Key limit exceeded" as quota_exhausted and keeps the manage-key URL', () => {
    const upstream = 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/94121a';
    const err = classifyOpenRouterError({
      status: 403,
      bodyText: JSON.stringify({ error: { message: upstream, code: 403 } }),
      cause: new Error('403'),
      requestId: 'or-req-1',
    });
    expect(err.kind).toBe('quota_exhausted');
    expect(err.message).toBe(`OpenRouter quota exhausted (status 403): ${upstream}`);
    expect(err.message).toContain('Key limit exceeded');
    expect(err.message).toContain('https://openrouter.ai/');
    expect(err.requestId).toBe('or-req-1');
    expect(err.code).toBeUndefined();
  });

  it('classifies legacy 403 "Key limit exceeded (monthly limit)" as quota_exhausted', () => {
    const err = classifyOpenRouterError({
      status: 403,
      bodyText: JSON.stringify({ error: { message: 'Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/keys/abc', code: 403 } }),
      cause: new Error('403'),
    });
    expect(err.kind).toBe('quota_exhausted');
    expect(err.message).toContain('Key limit exceeded (monthly limit)');
  });

  it('classifies legacy 402 (no marker) as quota_exhausted', () => {
    const err = classifyOpenRouterError({
      status: 402,
      bodyText: JSON.stringify({ error: { message: 'Payment required', code: 402 } }),
      cause: new Error('402'),
      requestId: 'or-req-402',
    });
    expect(err.kind).toBe('quota_exhausted');
    expect(err.message).toBe('OpenRouter quota exhausted (status 402): Payment required');
    expect(err.requestId).toBe('or-req-402');
  });

  it('classifies legacy 401 "User not found." as auth_invalid with the body in the message', () => {
    const err = classifyOpenRouterError({
      status: 401,
      bodyText: JSON.stringify({ error: { message: 'User not found.', code: 401 } }),
      cause: new Error('401'),
      requestId: 'or-req-401',
    });
    expect(err.kind).toBe('auth_invalid');
    expect(err.message).toBe('OpenRouter auth error (status 401): User not found.');
    expect(err.requestId).toBe('or-req-401');
  });

  it('classifies legacy 502 with a plain-text body as transient and keeps the body', () => {
    const err = classifyOpenRouterError({
      status: 502,
      bodyText: 'bad gateway from cloudflare',
      cause: new Error('502'),
      requestId: 'or-req-502',
    });
    expect(err.kind).toBe('transient');
    expect(err.message).toBe('OpenRouter upstream error (status 502): bad gateway from cloudflare');
    expect(err.requestId).toBe('or-req-502');
  });

  it('truncates a long non-JSON legacy body to 300 chars in the message', () => {
    const err = classifyOpenRouterError({
      status: 500,
      bodyText: 'x'.repeat(1000),
      cause: new Error('500'),
    });
    expect(err.kind).toBe('transient');
    expect(err.message).toBe(`OpenRouter upstream error (status 500): ${'x'.repeat(300)}`);
  });

  it('classifies legacy 429 with the body and Retry-After preserved', () => {
    const err = classifyOpenRouterError({
      status: 429,
      bodyText: JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }),
      headers: new Headers({ 'retry-after': '5' }),
      cause: new Error('429'),
      requestId: 'or-req-429',
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(5_000);
    expect(err.message).toBe('OpenRouter rate limit (status 429): Rate limit exceeded');
    expect(err.requestId).toBe('or-req-429');
  });

  it('classifies legacy 400 with the body in the message as unrecoverable', () => {
    const err = classifyOpenRouterError({
      status: 400,
      bodyText: JSON.stringify({ error: { message: 'model is required', code: 400 } }),
      cause: new Error('400'),
    });
    expect(err.kind).toBe('unrecoverable');
    expect(err.message).toBe('OpenRouter bad request (status 400): model is required');
  });
});

describe('describeProviderError', () => {
  it('renders message — action url (req id) when all parts are present', () => {
    const err = new ClassifiedProviderError('You have used your allowance.', {
      kind: 'quota_exhausted',
      cause: null,
      code: 'allowance_exhausted',
      action: 'Email support@cmem.ai.',
      url: 'https://cmem.ai/dashboard',
      requestId: 'abc',
    });
    expect(describeProviderError(err)).toBe(
      'You have used your allowance. — Email support@cmem.ai. https://cmem.ai/dashboard (req abc)',
    );
  });

  it('omits missing parts', () => {
    expect(describeProviderError(new ClassifiedProviderError('Only message', { kind: 'transient', cause: null })))
      .toBe('Only message');
    expect(describeProviderError(new ClassifiedProviderError('Msg', { kind: 'transient', cause: null, requestId: 'r1' })))
      .toBe('Msg (req r1)');
    expect(describeProviderError(new ClassifiedProviderError('Msg', { kind: 'transient', cause: null, action: 'Do it.' })))
      .toBe('Msg — Do it.');
    expect(describeProviderError(new ClassifiedProviderError('Msg', { kind: 'transient', cause: null, url: 'https://cmem.ai/dashboard' })))
      .toBe('Msg https://cmem.ai/dashboard');
  });

  it('renders legacy classified errors (no structured fields) as message + request id', () => {
    const err = classifyOpenRouterError({
      status: 403,
      bodyText: JSON.stringify({ error: { message: 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/keys/x', code: 403 } }),
      cause: new Error('403'),
      requestId: 'or-1',
    });
    expect(describeProviderError(err)).toBe(
      'OpenRouter quota exhausted (status 403): Key limit exceeded (total limit). Manage it using https://openrouter.ai/keys/x (req or-1)',
    );
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

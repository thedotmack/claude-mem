import { readFileSync } from 'fs';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createServer } from 'node:http';
import {
  classifyOpenAICompatError,
  isLocalEndpointUrl,
  OpenAICompatProvider,
  isOpenAICompatAvailable,
  isOpenAICompatSelected,
  resolveOpenAICompatConfig,
} from '../../src/services/worker/OpenAICompatProvider.js';
import {
  OPENAI_COMPAT_PRESETS,
  resolveOpenAICompatPreset,
} from '../../src/shared/openai-compat-presets.js';
import { getSelectedProvider } from '../../src/services/worker/provider-dispatch.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

/**
 * As in provider-dispatch.test.ts: SettingsDefaultsManager applies process.env
 * LAST, so pinning env vars (empty string included) fully determines the
 * outcome regardless of the temp settings file preload created.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_GEMINI_API_KEY',
] as const;

const NIM_BASE = 'https://integrate.api.nvidia.com/v1';

describe('openai-compatible presets', () => {
  it('ships an NVIDIA NIM preset pointing at the documented endpoint', () => {
    const nim = resolveOpenAICompatPreset('nvidia-nim');
    expect(nim.id).toBe('nvidia-nim');
    expect(nim.baseUrl).toBe(NIM_BASE);
    expect(nim.requiresApiKey).toBe(true);
    expect(nim.defaultModel).not.toBe('');
  });

  it('resolves case-insensitively and tolerates surrounding whitespace', () => {
    expect(resolveOpenAICompatPreset('  NVIDIA-NIM ').id).toBe('nvidia-nim');
  });

  it('degrades an unknown or blank preset to custom instead of throwing', () => {
    // A typo in settings.json is read during status polling; it must not crash.
    expect(resolveOpenAICompatPreset('nvidia-nimm').id).toBe('custom');
    expect(resolveOpenAICompatPreset('').id).toBe('custom');
    expect(resolveOpenAICompatPreset(undefined).id).toBe('custom');
    expect(resolveOpenAICompatPreset(42).id).toBe('custom');
  });

  it('has unique ids and a custom escape hatch', () => {
    const ids = OPENAI_COMPAT_PRESETS.map(preset => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('custom');
  });

  it('marks local presets as not needing a key', () => {
    for (const id of ['ollama', 'lmstudio', 'vllm']) {
      expect(resolveOpenAICompatPreset(id).requiresApiKey).toBe(false);
    }
  });

  it('gives every hosted preset a base URL', () => {
    for (const preset of OPENAI_COMPAT_PRESETS) {
      if (preset.id === 'custom') continue;
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
    }
  });
});

describe('resolveOpenAICompatConfig', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('takes base URL and model from the preset and appends /chat/completions', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe(`${NIM_BASE}/chat/completions`);
    expect(config.model).toBe(resolveOpenAICompatPreset('nvidia-nim').defaultModel);
    expect(config.apiKey).toBe('nvapi-test');
  });

  it('lets an explicit base URL and model win over the preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://my-gateway.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'my/model';

    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe('https://my-gateway.example.com/v1/chat/completions');
    expect(config.model).toBe('my/model');
  });

  it('does not double up when the base URL already names the path', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'k';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'm';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://x.example.com/v1/chat/completions';

    expect(resolveOpenAICompatConfig().apiUrl).toBe('https://x.example.com/v1/chat/completions');
  });

  it('builds a rotation pool with the primary key first', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = 'nvapi-2, nvapi-3';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiKeys).toEqual(['nvapi-1', 'nvapi-2', 'nvapi-3']);
    expect(config.apiKey).toBe('nvapi-1');
  });

  it('promotes the first listed key when only the list is set', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = 'nvapi-a\nnvapi-b';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiKey).toBe('nvapi-a');
    expect(config.apiKeys).toEqual(['nvapi-a', 'nvapi-b']);
  });

  it('yields no endpoint for a bare custom preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';

    expect(resolveOpenAICompatConfig().apiUrl).toBe('');
  });
});

describe('isOpenAICompatAvailable', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('is available with a NIM preset and a key', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('is unavailable with a NIM preset and no key at all', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('is available for a local preset with no key, once a model is set', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'ollama';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'qwen3:8b';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('is unavailable for a local preset with no model — a model is not guessable', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'ollama';
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('is unavailable for a bare custom preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('selects the provider only when settings name it', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    expect(isOpenAICompatSelected()).toBe(true);
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    expect(isOpenAICompatSelected()).toBe(false);
  });

  it('dispatch picks it when selected and configured', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    expect(getSelectedProvider()).toBe('openai-compatible');
  });

  it('dispatch falls through to claude when selected but half-configured', () => {
    // The existing silent fall-through: a misconfigured provider must not fail
    // every observation, it must let Claude take over.
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    expect(getSelectedProvider()).toBe('claude');
  });
});

/**
 * The settings API validates CLAUDE_MEM_PROVIDER against a hardcoded list, and
 * the viewer POSTs the WHOLE settings object on every save (see
 * src/ui/viewer/hooks/useSettings.ts). A provider id missing from that list
 * therefore does not merely hide the option — it 400s every subsequent save
 * from the settings modal, including saves of unrelated fields. Adding a
 * provider id without adding it here is the regression these tests catch.
 */
describe('settings API provider validation', () => {
  const validate = (provider: string): { valid: boolean; error?: string } =>
    (new SettingsRoutes({} as never) as unknown as {
      validateSettings(settings: unknown): { valid: boolean; error?: string };
    }).validateSettings({ CLAUDE_MEM_PROVIDER: provider });

  it('accepts every provider id dispatch can select', () => {
    for (const provider of ['claude', 'gemini', 'openrouter', 'openai-compatible']) {
      expect(validate(provider).valid).toBe(true);
    }
  });

  it('still rejects an unknown provider id, and names openai-compatible when it does', () => {
    const result = validate('not-a-provider');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('openai-compatible');
  });
});

describe('classifyOpenAICompatError', () => {
  it('separates a spent allowance from a per-minute throttle on the same 429', () => {
    const throttle = classifyOpenAICompatError({ status: 429, bodyText: 'Too many requests', cause: new Error('x') });
    expect(throttle.kind).toBe('rate_limit');

    const spent = classifyOpenAICompatError({ status: 429, bodyText: 'insufficient_quota', cause: new Error('x') });
    expect(spent.kind).toBe('quota_exhausted');
  });

  it('honors Retry-After on a rate limit', () => {
    const err = classifyOpenAICompatError({
      status: 429,
      bodyText: 'slow down',
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '12' : null) },
      cause: new Error('x'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('treats 402 as quota regardless of body', () => {
    expect(classifyOpenAICompatError({ status: 402, bodyText: '', cause: new Error('x') }).kind)
      .toBe('quota_exhausted');
  });

  it('classifies auth failures and names the setting to fix', () => {
    for (const status of [401, 403]) {
      const err = classifyOpenAICompatError({ status, bodyText: 'unauthorized', cause: new Error('x') });
      expect(err.kind).toBe('auth_invalid');
      expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
    }
  });

  it('tells a 404 apart and blames the base URL or model', () => {
    const err = classifyOpenAICompatError({ status: 404, bodyText: 'model not found', cause: new Error('x') });
    expect(err.kind).toBe('unrecoverable');
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_BASE_URL');
  });

  it('classifies 400/422 as unrecoverable and 5xx as transient', () => {
    expect(classifyOpenAICompatError({ status: 400, cause: new Error('x') }).kind).toBe('unrecoverable');
    expect(classifyOpenAICompatError({ status: 422, cause: new Error('x') }).kind).toBe('unrecoverable');
    expect(classifyOpenAICompatError({ status: 500, cause: new Error('x') }).kind).toBe('transient');
    expect(classifyOpenAICompatError({ status: 503, cause: new Error('x') }).kind).toBe('transient');
  });

  it('treats a request that never completed as transient', () => {
    const err = classifyOpenAICompatError({ cause: new Error('ECONNREFUSED') });
    expect(err.kind).toBe('transient');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('carries the endpoint label into the message, so logs name the endpoint', () => {
    const err = classifyOpenAICompatError({
      status: 500,
      bodyText: 'boom',
      cause: new Error('x'),
      endpointLabel: 'NVIDIA NIM (build.nvidia.com)',
    });
    expect(err.message).toContain('NVIDIA NIM');
  });
});

/**
 * Wave 3 gate R4-2: Groq and OpenAI end a per-minute throttle with a link to
 * their billing page. The loose "billing" marker read those as a spent
 * allowance, which parks the key for 30 minutes and arms the provider breaker
 * over a limit that clears in seconds.
 */
describe('a throttle that links to a billing page stays a rate limit', () => {
  const headers = (retryAfter: string) => ({ get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) });
  const groqTpm = JSON.stringify({ error: {
    message: 'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 11679, Requested 1462. Please try again in 5.705s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
    type: 'tokens', code: 'rate_limit_exceeded',
  } });
  const openaiRpm = JSON.stringify({ error: {
    message: 'Rate limit reached for gpt-4o-mini in organization org-abc on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.',
    type: 'requests', param: null, code: 'rate_limit_exceeded',
  } });

  it('reads Groq and OpenAI per-minute throttles as rate limits, with their Retry-After', () => {
    const groq = classifyOpenAICompatError({ status: 429, bodyText: groqTpm, headers: headers('6'), cause: new Error('x') });
    expect(groq.kind).toBe('rate_limit');
    expect(groq.retryAfterMs).toBe(6_000);

    const openai = classifyOpenAICompatError({ status: 429, bodyText: openaiRpm, headers: headers('20'), cause: new Error('x') });
    expect(openai.kind).toBe('rate_limit');
    expect(openai.retryAfterMs).toBe(20_000);
  });

  it('still reads a spent allowance as quota, on a 429 too', () => {
    const openaiQuota = JSON.stringify({ error: {
      message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota', param: null, code: 'insufficient_quota',
    } });
    expect(classifyOpenAICompatError({ status: 429, bodyText: openaiQuota, cause: new Error('x') }).kind).toBe('quota_exhausted');
  });

  it('keeps reading a billing refusal that is not a throttle as quota', () => {
    const hardLimit = JSON.stringify({ error: { message: 'Billing hard limit has been reached', type: 'invalid_request_error', code: 'billing_hard_limit_reached' } });
    expect(classifyOpenAICompatError({ status: 400, bodyText: hardLimit, cause: new Error('x') }).kind).toBe('quota_exhausted');
  });
});

/**
 * Several OpenAI-compatible gateways report a throttle in a 200 body rather
 * than a 429 — the shape #3263 hit through OpenRouter. A status-only
 * classifier calls that `unrecoverable`, which neither retries nor rotates the
 * key, so the pool never moves off a key that is merely throttled.
 */
describe('structured error envelopes outrank the transport status', () => {
  const classify = (body: unknown, status = 200) =>
    classifyOpenAICompatError({ status, bodyText: JSON.stringify(body), cause: new Error('x') });

  it('maps a rate-limit code in a 200 body to rate_limit', () => {
    expect(classify({ error: { message: 'slow down', code: 'rate_limited' } }).kind).toBe('rate_limit');
    expect(classify({ error: { message: 'slow down', type: 'rate_limit_error' } }).kind).toBe('rate_limit');
    expect(classify({ error: { code: 'rate_limit_exceeded' } }).kind).toBe('rate_limit');
  });

  it('lets quota markers keep winning over a rate-limit reading', () => {
    expect(classify({ error: { code: 'insufficient_quota' } }).kind).toBe('quota_exhausted');
  });

  it('does not turn an unknown structured failure into a rate limit', () => {
    expect(classify({ error: { code: 'weird_thing', message: 'boom' } }).kind).toBe('unrecoverable');
  });

  it('survives a body that is not JSON at all', () => {
    expect(classifyOpenAICompatError({ status: 500, bodyText: '<html>502</html>', cause: new Error('x') }).kind)
      .toBe('transient');
  });

  it('leaves the ordinary 429 path alone', () => {
    expect(classifyOpenAICompatError({ status: 429, bodyText: 'Too Many Requests', cause: new Error('x') }).kind)
      .toBe('rate_limit');
  });
});

/**
 * A preset bundles two separate facts — where to send the request, and whether
 * that place wants a bearer token. CLAUDE_MEM_OPENAI_COMPAT_BASE_URL replaces
 * the first, so keeping the second breaks in both directions: a keyless local
 * override gets refused for want of a key it does not need, and a hosted
 * override reports itself ready and then 401s on every observation.
 */
describe('auth policy follows the endpoint actually configured', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('reads loopback, LAN and .local hosts as keyless-capable', () => {
    for (const url of [
      'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8000/v1',
      'http://192.168.1.50:8000/v1', 'http://10.0.0.4:8000/v1', 'http://172.16.5.5:8000/v1',
      'http://box.local:8000/v1',
    ]) expect(isLocalEndpointUrl(url)).toBe(true);
  });

  it('treats a remote host as needing a key, and a malformed URL as remote', () => {
    for (const url of [
      'https://api.groq.com/openai/v1', 'https://integrate.api.nvidia.com/v1',
      'https://localhost.evil.com/v1', 'not a url',
    ]) expect(isLocalEndpointUrl(url)).toBe(false);
  });

  it('runs a keyless local override even when the preset is a hosted one', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'http://localhost:11434/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'llama3';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('refuses a hosted override with no key instead of 401ing every observation', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'ollama';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'x';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    expect(isOpenAICompatAvailable()).toBe(false);
  });
});

/**
 * The superclass hands `query()` the field-compression deadline. Dropping it
 * means the request outlives the budget that cancelled it and keeps retrying
 * in the background — the same wiring `field-deadline-wire.test.ts` pins for
 * OpenRouter.
 */
describe('field-deadline cancellation reaches the socket', () => {
  it('accepts the signal, aborts in flight, and starts no retries', async () => {
    let requests = 0;
    const server = createServer((req) => { requests++; /* never answer */ void req; });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const provider = new OpenAICompatProvider({} as never, {} as never);
      const controller = new AbortController();
      const config = {
        apiKey: 'fixture-not-a-secret',
        apiKeys: ['fixture-not-a-secret'],
        model: 'fixture',
        apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
        preset: resolveOpenAICompatPreset('custom'),
        requiresApiKey: false,
      };
      const pending = (provider as unknown as {
        query(h: unknown[], c: unknown, s?: AbortSignal): Promise<unknown>;
      }).query([{ role: 'user', content: 'hi' }], config, controller.signal).catch((e: Error) => e);

      await new Promise(resolve => setTimeout(resolve, 100));
      controller.abort();
      await pending;
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(controller.signal.aborted).toBe(true);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 5000);
});

/**
 * The quota scan matches loose body words, "billing" among them, and a 401/403
 * very often explains itself in billing terms. Reading that as a spent
 * allowance retires the key for 30 minutes and can arm the provider breaker,
 * when the actual fix is a new key — so status has to win for auth failures.
 */
describe('auth failures are not mistaken for spent quota', () => {
  const kind = (status: number, body: string) =>
    classifyOpenAICompatError({ status, bodyText: body, cause: new Error('x') }).kind;

  it('classifies a 401/403 as auth even when the body talks about billing', () => {
    expect(kind(401, '{"error":{"message":"Invalid API key. Update your billing details."}}')).toBe('auth_invalid');
    expect(kind(403, '{"error":{"message":"Key revoked; see billing portal"}}')).toBe('auth_invalid');
    expect(kind(401, '{"error":{"message":"out of credits"}}')).toBe('auth_invalid');
  });

  it('still reads genuine quota signals as quota', () => {
    expect(kind(402, 'payment required')).toBe('quota_exhausted');
    expect(kind(429, '{"error":{"message":"insufficient_quota"}}')).toBe('quota_exhausted');
    expect(kind(429, 'credit limit reached')).toBe('quota_exhausted');
  });

  it('leaves the other classifications untouched', () => {
    expect(kind(429, 'Too Many Requests')).toBe('rate_limit');
    expect(kind(404, 'not found')).toBe('unrecoverable');
    expect(kind(500, 'boom')).toBe('transient');
  });
});

/** Same credential rule as the rotation pools: never returned in cleartext. */
describe('openai-compatible credentials are registered as secrets', () => {
  it('redacts both the key and the pool on GET /api/settings', () => {
    const source = readFileSync(
      new URL('../../src/services/worker/http/routes/SettingsRoutes.ts', import.meta.url),
      'utf-8',
    );
    const secretBlock = source.slice(
      source.indexOf('const SECRET_SETTING_KEYS'),
      source.indexOf('function maskSecretValue'),
    );
    expect(secretBlock).toContain("'CLAUDE_MEM_OPENAI_COMPAT_API_KEY'");
    expect(secretBlock).toContain("'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS'");
  });
});

/**
 * Main's observer contract, which this provider shares with OpenRouter: the
 * system anchor and turn normalization (#3868, #3491), text-only answers
 * (#4017), and the configurable output cap (#3868) with the
 * max_completion_tokens retry (#4003).
 */
describe('openai-compatible requests follow the shared observer contract', () => {
  const CONFIG = {
    apiKey: 'fixture-not-a-secret',
    apiKeys: ['fixture-not-a-secret'],
    model: 'fixture/model',
    apiUrl: 'https://compat.example.test/v1/chat/completions',
    preset: resolveOpenAICompatPreset('custom'),
    requiresApiKey: true,
  };
  let settingsOverrides: Record<string, string> = {};
  let spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    settingsOverrides = {};
    spies = [spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...settingsOverrides,
    }))];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  const query = (history: ConversationMessage[]) =>
    (new OpenAICompatProvider({} as never, {} as never) as unknown as {
      query(h: ConversationMessage[], c: unknown): Promise<{ content: string; finishReason?: string }>;
    }).query(history, CONFIG);

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const sentBodies = (fetchSpy: { mock: { calls: unknown[][] } }) =>
    fetchSpy.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));

  it('sends no empty turn, no doubled role and no leading assistant turn', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    await query([
      { role: 'assistant', content: 'stray' },
      { role: 'user', content: 'init request' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'observation 1' },
    ]);

    expect(sentBodies(fetchSpy)[0].messages).toEqual([
      { role: 'user', content: 'init request\n\nobservation 1' },
    ]);
  });

  it('anchors a generation framing prompt as the system message', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    await query([{
      role: 'user',
      content: 'Instructions here.\n\n<observed_from_primary_session>\n<user_request>fix it</user_request>\n</observed_from_primary_session>',
      framing: true,
    }]);

    const [system, user] = sentBodies(fetchSpy)[0].messages;
    expect(system.role).toBe('system');
    expect(user.role).toBe('user');
    expect(user.content).toContain('<user_request>fix it</user_request>');
  });

  it('reads text blocks from a content array, never reasoning', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: '<observation>one</observation>' },
        { type: 'text', text: '<observation>two</observation>' },
      ] }, finish_reason: 'stop' }],
    })));

    const result = await query([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('<observation>one</observation>\n<observation>two</observation>');
    expect(result.finishReason).toBe('stop');
  });

  it('returns no text, not an object, when content is neither a string nor text blocks', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: { unexpected: true } } }],
    })));
    spies.push(spyOn(logger, 'error').mockImplementation(() => {}));

    const result = await query([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('');
  });

  it('sends CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS as the output cap in a plain, streamed body', async () => {
    settingsOverrides.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '9000';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    await query([{ role: 'user', content: 'hi' }]);

    const [body] = sentBodies(fetchSpy);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'stream_options', 'temperature']);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(9000);
  });

  it('resends max_completion_tokens when the model only takes that (#4003)', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ error: {
        message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter',
      } }, 400))
      .mockResolvedValueOnce(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    const result = await query([{ role: 'user', content: 'hi' }]);

    const [first, second] = sentBodies(fetchSpy);
    expect(first.max_tokens).toBe(4096);
    expect(second.max_tokens).toBeUndefined();
    expect(second.max_completion_tokens).toBe(4096);
    expect(result.content).toBe('ok');
  });

  const compressField = (signal = new AbortController().signal) =>
    (new OpenAICompatProvider({} as never, {} as never) as unknown as {
      compressField(t: string, b: number, c: unknown, s: AbortSignal): Promise<{ text: string; truncated: boolean } | null>;
    }).compressField('a large payload', 1000, CONFIG, signal);

  it('reports a condense reply cut at max_tokens as truncated', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: 'the first half of a summ' }, finish_reason: 'length' }],
    })));
    spies.push(spyOn(logger, 'warn').mockImplementation(() => {}));

    expect(await compressField()).toEqual({ text: 'the first half of a summ', truncated: true });
  });

  it('reports a condense reply that stopped on its own as complete', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: 'a whole summary' }, finish_reason: 'stop' }],
    })));

    expect(await compressField()).toEqual({ text: 'a whole summary', truncated: false });
  });

  it('bounds the condense budget by CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS', () => {
    settingsOverrides.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '3200';
    const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
      fieldCompressionMaxOutputTokens(): number | undefined;
    };
    expect(provider.fieldCompressionMaxOutputTokens()).toBe(3200);
  });
});

/** #3263's lesson, applied here: a 200 envelope carries the status that matters. */
describe('200 error envelopes are classified by what they report', () => {
  const classify = (error: Record<string, unknown>) =>
    classifyOpenAICompatError({ status: 200, bodyText: JSON.stringify({ error }), cause: new Error('x') });

  it('reads a numeric error.code as the effective status', () => {
    expect(classify({ code: 429, message: 'Too many requests' }).kind).toBe('rate_limit');
    expect(classify({ code: 503, message: 'upstream unavailable' }).kind).toBe('transient');
    expect(classify({ code: '502', message: 'bad gateway' }).kind).toBe('transient');
    expect(classify({ code: 401, message: 'bad key' }).kind).toBe('auth_invalid');
  });

  // Never pay twice (Phase 1): the model ran and was billed; only its output
  // was lost, so a resend would pay for the same work again. It used to be
  // classified transient and retried.
  it('treats a litellm parse failure as an output failure, never retried', () => {
    const err = classify({ code: 200, message: 'Unable to get json response - Expecting value: line 45 column 1' });
    expect(err.kind).toBe('unrecoverable');
    expect(err.paidSendOutcome).toBe('output_failure');
    expect(err.message).toContain('Unable to get json response');
  });

  it('keeps an unrelated 200 envelope unrecoverable', () => {
    expect(classify({ code: 200, message: 'something else' }).kind).toBe('unrecoverable');
  });
});

/**
 * #4276's key lock covers every provider: an account-owned cm_pro_ key never
 * leaves for a third-party endpoint, and the gateway never gets another key.
 */
describe('openai-compatible keys go through the cmem key lock', () => {
  const LOCK_ENV_KEYS = [...ENV_KEYS, 'CMEM_PRO_ORIGIN'];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of LOCK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'm';
  });

  afterEach(() => {
    for (const key of LOCK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('withholds a cm_pro_ key from a third-party endpoint', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'cm_pro_0123456789abcdef01234567';

    const config = resolveOpenAICompatConfig();
    expect(config.apiKey).toBe('');
    expect(config.apiKeys).toEqual([]);
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('drops a cm_pro_ key pasted into the rotation list and keeps the endpoint keys', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = 'cm_pro_0123456789abcdef01234567, nvapi-2';

    expect(resolveOpenAICompatConfig().apiKeys).toEqual(['nvapi-1', 'nvapi-2']);
  });

  it('never sends a personal key to the cmem gateway', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://cmem.ai/api/inference/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-personal';

    expect(resolveOpenAICompatConfig().apiKeys).toEqual([]);
    expect(isOpenAICompatAvailable()).toBe(false);
  });
});

/** The wrap-up runs on the provider the session observed with (SessionRoutes). */
describe('Telegram wrap-ups on the openai-compatible provider', () => {
  const input = {
    sessionDbId: 7,
    contentSessionId: 'content-7',
    project: 'p',
    platformSource: 'claude',
    summaryText: 'request\ncompleted',
  };

  it('SessionRoutes formats an openai-compatible session with the openai-compatible agent', async () => {
    let formatter: ((value: typeof input) => Promise<string>) | undefined;
    const sessionManager = {
      setTelegramWrapupFormatter: (fn: typeof formatter) => { formatter = fn; },
      getSession: () => ({ currentProvider: 'openai-compatible', lastModelId: 'local-model' }),
    };
    const otherAgent = { formatTelegramWrapup: async () => { throw new Error('wrong agent'); } };
    const compatAgent = { formatTelegramWrapup: mock(async () => '• Finished') };

    new SessionRoutes(
      sessionManager as never, {} as never, otherAgent as never, otherAgent as never, otherAgent as never,
      {} as never, {} as never, {} as never, otherAgent as never, compatAgent as never,
    );

    await expect(formatter!(input)).resolves.toBe('• Finished');
    expect(compatAgent.formatTelegramWrapup).toHaveBeenCalledWith(input, 'local-model');
  });

  it('formats a wrap-up on a keyless local endpoint', async () => {
    const provider = new OpenAICompatProvider({} as never, {} as never);
    const config = {
      apiKey: '', apiKeys: [], model: 'llama3', requiresApiKey: false,
      apiUrl: 'http://localhost:11434/v1/chat/completions', preset: resolveOpenAICompatPreset('ollama'),
    };
    const spies = [
      spyOn(provider as never, 'getConfig').mockReturnValue(config as never),
      spyOn(provider as never, 'query').mockResolvedValue({ content: '• Finished' } as never),
    ];
    try {
      await expect(provider.formatTelegramWrapup(input as never)).resolves.toBe('• Finished');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

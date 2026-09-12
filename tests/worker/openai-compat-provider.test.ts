import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
  openAICompatPresetIds,
  resolveOpenAICompatPreset,
} from '../../src/shared/openai-compat-presets.js';
import { getSelectedProvider } from '../../src/services/worker/provider-dispatch.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

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
    const ids = openAICompatPresetIds();
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

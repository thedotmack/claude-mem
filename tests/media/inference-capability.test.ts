// Phase 4 capability qualification: frozen capability.json fixtures, the
// shared context-window catalogue cache (TTL 3600 s ok / 60 s fail, one
// in-flight request), alias cases, and the cmem gateway capability response
// overriding local configuration.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { __resetContextWindowCacheForTests, resolveContextWindowTokens } from '../../src/services/worker/context-window.js';
import {
  __resetMediaCapabilityCacheForTests,
  gatewayCapabilitiesUrl,
  localImageTurnParameters,
  parseGatewayCapabilityResponse,
  qualifyCatalogModels,
  resolveObserverImageCapability,
} from '../../src/services/worker/media-capability.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/media-v1/inference/capability.json', import.meta.url), 'utf8'));
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GATEWAY_URL = 'https://cmem.ai/api/inference/v1/chat/completions';
const CAPABILITIES_URL = 'https://cmem.ai/api/inference/v1/capabilities';
const caseNamed = (name: string) => fixture.qualification_cases.find((entry: { name: string }) => entry.name === name);
const responseNamed = (name: string) => fixture.responses.find((entry: { name: string }) => entry.name === name);

let inferenceFlag = 'true';
let settingsSpy: ReturnType<typeof spyOn>;
let originalFetch: typeof fetch;
let fetchCalls: string[];

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchCalls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
}

function catalogResponse(models: unknown[]) {
  return new Response(JSON.stringify({ data: models }), { status: 200 });
}

beforeEach(() => {
  __resetContextWindowCacheForTests();
  __resetMediaCapabilityCacheForTests();
  inferenceFlag = 'true';
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: inferenceFlag,
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsSpy.mockRestore();
  mock.restore();
});

describe('qualification_cases (capability.json)', () => {
  for (const qualification of fixture.qualification_cases) {
    it(qualification.name, () => {
      const result = qualifyCatalogModels(
        qualification.catalog.map((entry: Record<string, unknown>) => ({
          id: entry.id,
          canonical_slug: entry.canonical_slug ?? null,
          alias_target: entry.alias_target ?? null,
          context_length: null,
          architecture: entry.architecture ?? null,
          supported_parameters: entry.supported_parameters ?? null,
        })),
        qualification.requested,
        qualification.required_parameters,
      );
      expect(result).toEqual(qualification.expected);
    });
  }

  it('the worker requires reasoning only when it sends the typed effort to openrouter.ai', () => {
    expect(localImageTurnParameters({ apiUrl: OPENROUTER_URL })).toEqual(['max_tokens', 'temperature']);
    expect(localImageTurnParameters({ apiUrl: OPENROUTER_URL, reasoningEffort: 'low' })).toEqual(['max_tokens', 'temperature', 'reasoning']);
    expect(localImageTurnParameters({ apiUrl: GATEWAY_URL, reasoningEffort: 'low' })).toEqual(['max_tokens', 'temperature']);
  });

  it('requires every model parameter CLAUDE_MEM_OPENROUTER_EXTRA_BODY sends, but not request options', () => {
    const extraBody = { top_p: 0.9, provider: { sort: 'price' }, reasoning: { effort: 'low' }, usage: { include: true }, max_tokens: 1, seed: 7 };
    expect(localImageTurnParameters({ apiUrl: OPENROUTER_URL, extraBody })).toEqual(['max_tokens', 'temperature', 'top_p', 'reasoning', 'seed']);
    expect(localImageTurnParameters({ apiUrl: OPENROUTER_URL, reasoningEffort: 'low', extraBody })).toEqual(['max_tokens', 'temperature', 'reasoning', 'top_p', 'seed']);
    // The cmem gateway never receives the extra body.
    expect(localImageTurnParameters({ apiUrl: GATEWAY_URL, extraBody })).toEqual(['max_tokens', 'temperature']);
  });

  it('an extra-body parameter the model does not list disqualifies it', async () => {
    mockFetch(() => catalogResponse(caseNamed('alias_to_image_capable').catalog));
    const config = { apiUrl: OPENROUTER_URL, apiKey: 'k', model: '~deepseek/deepseek-flash-latest', fallbackModels: [] as string[] };
    expect(await resolveObserverImageCapability({ ...config, extraBody: { top_p: 0.9 } })).toEqual({ supported: false, reason: 'missing_parameters' });
    expect(await resolveObserverImageCapability({ ...config, extraBody: { provider: { sort: 'price' } } })).toMatchObject({ supported: true });
  });
});

describe('direct OpenRouter qualification through the shared catalogue cache', () => {
  const imageCase = caseNamed('alias_to_image_capable');
  const config = (overrides: Record<string, unknown> = {}) => ({
    apiUrl: OPENROUTER_URL, apiKey: 'sk-or-test', model: imageCase.requested, fallbackModels: [] as string[], ...overrides,
  });

  it('qualifies an alias that resolves to an image-capable model', async () => {
    mockFetch(() => catalogResponse(imageCase.catalog));
    expect(await resolveObserverImageCapability(config())).toMatchObject({ supported: true });
  });

  it('follows an alias moved to a text-only model', async () => {
    mockFetch(() => catalogResponse(caseNamed('alias_to_text_only').catalog));
    expect(await resolveObserverImageCapability(config())).toEqual({ supported: false, reason: 'model_not_image_capable' });
  });

  it('fails closed on a missing alias target and on an alias cycle', async () => {
    mockFetch(() => catalogResponse(caseNamed('alias_missing_target').catalog));
    expect(await resolveObserverImageCapability(config({ model: '~example/latest' }))).toEqual({ supported: false, reason: 'model_unresolved' });
    __resetContextWindowCacheForTests();
    mockFetch(() => catalogResponse(caseNamed('alias_cycle').catalog));
    expect(await resolveObserverImageCapability(config({ model: '~example/a' }))).toEqual({ supported: false, reason: 'model_unresolved' });
  });

  it('requires reasoning support when the typed effort is sent', async () => {
    const catalog = [{ ...imageCase.catalog[1], supported_parameters: ['max_tokens', 'temperature'] }, imageCase.catalog[0]];
    mockFetch(() => catalogResponse(catalog));
    expect(await resolveObserverImageCapability(config({ reasoningEffort: 'low' }))).toEqual({ supported: false, reason: 'missing_parameters' });
    expect(await resolveObserverImageCapability(config())).toMatchObject({ supported: true });
  });

  it('requires every configured fallback model to qualify', async () => {
    mockFetch(() => catalogResponse(caseNamed('local_fallback_list_requires_every_model').catalog));
    expect(await resolveObserverImageCapability(config({ model: 'example/vision', fallbackModels: ['example/text-only'] })))
      .toEqual({ supported: false, reason: 'model_not_image_capable' });
    expect(await resolveObserverImageCapability(config({ model: 'example/vision', fallbackModels: [] })))
      .toMatchObject({ supported: true });
  });

  it('one catalogue GET serves context windows and qualification, with one request in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mockFetch(async () => {
      await gate;
      return catalogResponse([...imageCase.catalog.map((entry: object) => ({ ...entry, context_length: 131072 }))]);
    });
    const pending = Promise.all([
      resolveObserverImageCapability(config()),
      resolveObserverImageCapability(config()),
      resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4.1-flash', OPENROUTER_URL),
    ]);
    release();
    const [first, second, window] = await pending;
    expect(first).toMatchObject({ supported: true });
    expect(second).toMatchObject({ supported: true });
    expect(window).toBe(131072);
    expect(fetchCalls).toEqual(['https://openrouter.ai/api/v1/models']);
  });

  it('caches a success for 3600 s and an outage for 60 s', async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockFetch(() => catalogResponse(imageCase.catalog));
      await resolveObserverImageCapability(config());
      now += 3_599_000;
      await resolveObserverImageCapability(config());
      expect(fetchCalls).toHaveLength(1);
      now += 2_000;
      mockFetch(() => new Response('down', { status: 503 }));
      expect(await resolveObserverImageCapability(config())).toEqual({ supported: false, reason: 'catalog_unavailable' });
      expect(fetchCalls).toHaveLength(2);
      now += 59_000;
      expect(await resolveObserverImageCapability(config())).toEqual({ supported: false, reason: 'catalog_unavailable' });
      expect(fetchCalls).toHaveLength(2);
      now += 2_000;
      mockFetch(() => catalogResponse(imageCase.catalog));
      expect(await resolveObserverImageCapability(config())).toMatchObject({ supported: true });
      expect(fetchCalls).toHaveLength(3);
    } finally {
      clock.mockRestore();
    }
  });

  it('treats a network failure as catalog_unavailable, never as an error', async () => {
    mockFetch(() => { throw new Error('offline'); });
    expect(await resolveObserverImageCapability(config())).toEqual({ supported: false, reason: 'catalog_unavailable' });
  });

  it('is off by default and independent of the capture flag', async () => {
    inferenceFlag = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_MEDIA_INFERENCE_ENABLED;
    expect(inferenceFlag).toBe('false');
    settingsSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true',
    }));
    mockFetch(() => catalogResponse(imageCase.catalog));
    expect(await resolveObserverImageCapability(config())).toEqual({ supported: false, reason: 'inference_disabled' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('never qualifies an arbitrary OpenAI-compatible base URL', async () => {
    mockFetch(() => catalogResponse(imageCase.catalog));
    for (const apiUrl of ['https://api.deepseek.com/chat/completions', 'http://localhost:1234/v1/chat/completions']) {
      expect(await resolveObserverImageCapability(config({ apiUrl }))).toEqual({ supported: false, reason: 'endpoint_unsupported' });
    }
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('cmem gateway capability response', () => {
  const gatewayConfig = (model = 'deepseek/deepseek-v4-flash') => ({
    apiUrl: GATEWAY_URL, apiKey: 'cm_pro_0123456789abcdef01234567', model, fallbackModels: [] as string[],
  });

  it('derives the capabilities URL from the chat-completions endpoint', () => {
    expect(gatewayCapabilitiesUrl(GATEWAY_URL)).toBe(CAPABILITIES_URL);
    expect(gatewayCapabilitiesUrl('http://localhost:3005/mock/api/inference/v1/chat/completions'))
      .toBe('http://localhost:3005/mock/api/inference/v1/capabilities');
  });

  it('parses every fixture 200 response and rejects malformed or unknown versions', () => {
    for (const response of fixture.responses.filter((entry: { status: number }) => entry.status === 200)) {
      const parsed = parseGatewayCapabilityResponse(response.body);
      expect(parsed).not.toBeNull();
      expect(parsed!.capability.supported).toBe(response.body.supports_image_input);
      expect(parsed!.ttlMs).toBe(response.body.ttl_seconds * 1000);
    }
    const qualified = responseNamed('qualified').body;
    expect(parseGatewayCapabilityResponse({ ...qualified, version: 2 })).toBeNull();
    expect(parseGatewayCapabilityResponse({ ...qualified, api_key: 'x' })).toBeNull();
    expect(parseGatewayCapabilityResponse({ ...qualified, bounds: null })).toBeNull();
    expect(parseGatewayCapabilityResponse({ ...responseNamed('text_only_model').body, reason: 'other' })).toBeNull();
  });

  it('follows the server-selected model when the local configuration differs', async () => {
    // Locally configured model is text-only in the public catalogue; the
    // gateway overrides the model and says its selection qualifies.
    mockFetch(url => url === CAPABILITIES_URL
      ? new Response(JSON.stringify(responseNamed('qualified').body), { status: 200 })
      : catalogResponse(caseNamed('alias_to_text_only').catalog));
    const capability = await resolveObserverImageCapability(gatewayConfig());
    expect(capability).toMatchObject({ supported: true });
    expect(capability.supported && capability.bounds).toEqual(responseNamed('qualified').body.bounds);
    expect(fetchCalls).toEqual([CAPABILITIES_URL]);
  });

  it('follows a server override to a text-only model even when the local model is image-capable', async () => {
    mockFetch(url => url === CAPABILITIES_URL
      ? new Response(JSON.stringify(responseNamed('text_only_model').body), { status: 200 })
      : catalogResponse(caseNamed('alias_to_image_capable').catalog));
    expect(await resolveObserverImageCapability(gatewayConfig('~deepseek/deepseek-flash-latest')))
      .toEqual({ supported: false, reason: 'model_not_image_capable' });
    expect(fetchCalls).toEqual([CAPABILITIES_URL]);
  });

  it('sends the memory key as a bearer and caches for ttl_seconds with one request in flight', async () => {
    let now = 5_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const authorizations: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push(String(input));
      authorizations.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify(responseNamed('qualified').body), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await Promise.all([resolveObserverImageCapability(gatewayConfig()), resolveObserverImageCapability(gatewayConfig())]);
      expect(fetchCalls).toHaveLength(1);
      expect(authorizations).toEqual(['Bearer cm_pro_0123456789abcdef01234567']);
      now += 3_599_000;
      await resolveObserverImageCapability(gatewayConfig());
      expect(fetchCalls).toHaveLength(1);
      now += 2_000;
      await resolveObserverImageCapability(gatewayConfig());
      expect(fetchCalls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('treats outages, non-2xx, malformed bodies and unknown versions as unavailable for 60 s', async () => {
    let now = 9_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const outcomes: Array<() => Response> = [
      () => { throw new Error('offline'); },
      () => new Response(JSON.stringify(responseNamed('unauthenticated').body), { status: 401 }),
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ ...responseNamed('qualified').body, version: 2 }), { status: 200 }),
    ];
    try {
      for (const outcome of outcomes) {
        __resetMediaCapabilityCacheForTests();
        fetchCalls = [];
        mockFetch(outcome);
        expect(await resolveObserverImageCapability(gatewayConfig())).toEqual({ supported: false, reason: 'catalog_unavailable' });
        now += 59_000;
        await resolveObserverImageCapability(gatewayConfig());
        expect(fetchCalls).toHaveLength(1);
        now += 2_000;
        await resolveObserverImageCapability(gatewayConfig());
        expect(fetchCalls).toHaveLength(2);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('honors the 60 s ttl of a catalog_unavailable answer from the server', async () => {
    let now = 20_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockFetch(() => new Response(JSON.stringify(responseNamed('catalog_unavailable').body), { status: 200 }));
      expect(await resolveObserverImageCapability(gatewayConfig())).toEqual({ supported: false, reason: 'catalog_unavailable' });
      now += 61_000;
      await resolveObserverImageCapability(gatewayConfig());
      expect(fetchCalls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('asks nothing when inference is disabled', async () => {
    inferenceFlag = 'false';
    mockFetch(() => new Response(JSON.stringify(responseNamed('qualified').body), { status: 200 }));
    expect(await resolveObserverImageCapability(gatewayConfig())).toEqual({ supported: false, reason: 'inference_disabled' });
    expect(fetchCalls).toHaveLength(0);
  });
});

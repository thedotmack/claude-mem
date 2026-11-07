import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager';
import {
  resolveContextWindowTokens,
  observationFieldMaxChars,
  condenseInputMaxTokens,
  estimateCondenseTokens,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  __resetContextWindowCacheForTests,
  fetchOpenRouterModelCatalog,
} from '../../src/services/worker/context-window';
import { OBS_PROMPT_FIELD_MAX_CHARS } from '../../src/sdk/prompts';
import { cmemProOrigin } from '../../src/shared/cmem-gateway';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CUSTOM_URL = 'http://localhost:8080/v1/chat/completions';

// Trimmed from a live `curl https://openrouter.ai/api/v1/models` (2026-08-08):
// each entry carries a top-level numeric `context_length`.
const CATALOGUE_BODY = JSON.stringify({
  data: [
    { id: 'inclusionai/ling-3.0-tiny:free', context_length: 262144 },
    { id: 'deepseek/deepseek-v4-flash', context_length: 163840 },
    { id: 'broken/no-window' },
  ],
});

let contextWindowSetting = '';
let loadFromFileSpy: ReturnType<typeof spyOn>;
let originalFetch: typeof global.fetch;

function mockCatalogueFetch(body: string = CATALOGUE_BODY, status = 200) {
  global.fetch = mock(() => Promise.resolve(new Response(body, { status })));
}

describe('resolveContextWindowTokens', () => {
  beforeEach(() => {
    __resetContextWindowCacheForTests();
    contextWindowSetting = '';
    originalFetch = global.fetch;

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW: contextWindowSetting,
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    mock.restore();
  });

  it('returns the catalogue context_length for a known OpenRouter model', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    expect(window).toBe(163840);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as any).mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
  });

  it('falls back when the model is absent from the catalogue', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'nonexistent/model', OPENROUTER_URL);

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back when the catalogue entry has no numeric context_length', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'broken/no-window', OPENROUTER_URL);

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back on a non-OK catalogue response', async () => {
    mockCatalogueFetch('upstream error', 500);

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back without throwing when fetch rejects (offline/timeout)', async () => {
    global.fetch = mock(() => Promise.reject(new Error('network down')));

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('serves a second call within the TTL from the cache (single fetch)', async () => {
    mockCatalogueFetch();

    const first = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);
    const second = await resolveContextWindowTokens('openrouter', 'inclusionai/ling-3.0-tiny:free', OPENROUTER_URL);

    expect(first).toBe(163840);
    expect(second).toBe(262144);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a failed fetch (immediate next call falls back without refetching)', async () => {
    const failingFetch = mock(() => Promise.reject(new Error('network down')));
    global.fetch = failingFetch;
    await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it('retries after the failure TTL (reset stands in for expiry) and picks up the live value', async () => {
    global.fetch = mock(() => Promise.reject(new Error('network down')));
    await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    __resetContextWindowCacheForTests();
    mockCatalogueFetch();
    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    expect(window).toBe(163840);
  });

  it('coalesces concurrent cold lookups into a single catalogue fetch', async () => {
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const gatedFetch = mock(async () => {
      await gate;
      return new Response(JSON.stringify({
        data: [{ id: 'deepseek/deepseek-v4-flash', context_length: 163840 }],
      }), { status: 200 });
    });
    global.fetch = gatedFetch as any;

    const lookups = Promise.all(
      Array.from({ length: 5 }, () =>
        resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL)),
    );
    releaseFetch!();
    const windows = await lookups;

    expect(windows).toEqual([163840, 163840, 163840, 163840, 163840]);
    expect(gatedFetch).toHaveBeenCalledTimes(1);
  });

  it('lets the settings override win over the catalogue, with no fetch', async () => {
    contextWindowSetting = '200000';
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL);

    expect(window).toBe(200000);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('ignores a non-positive or non-numeric settings override', async () => {
    mockCatalogueFetch();

    contextWindowSetting = '0';
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL)).toBe(163840);

    contextWindowSetting = 'not-a-number';
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL)).toBe(163840);

    // A typo is not a 16-token window: only a complete integer counts.
    contextWindowSetting = '16k';
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL)).toBe(163840);
  });

  it('clamps an unusably small settings override up to the minimum window', async () => {
    mockCatalogueFetch();

    // Prompt scaffolding alone is ~1k tokens, so a 16-token window can never
    // fit a request no matter how far payloads shrink (PR #3516 review).
    contextWindowSetting = '16';
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL)).toBe(MIN_CONTEXT_WINDOW_TOKENS);

    contextWindowSetting = String(MIN_CONTEXT_WINDOW_TOKENS);
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', OPENROUTER_URL)).toBe(MIN_CONTEXT_WINDOW_TOKENS);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('falls back for a custom OpenAI-compatible endpoint with no fetch', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', CUSTOM_URL);

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('looks up the cmem.ai gateway in the catalogue, like openrouter.ai', async () => {
    mockCatalogueFetch();

    const gatewayUrl = `${cmemProOrigin()}/api/inference/v1/chat/completions`;
    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', gatewayUrl);

    expect(window).toBe(163840);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back when the endpoint is unknown, with no fetch', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('returns 1,048,576 for known Gemini models without fetching', async () => {
    mockCatalogueFetch();

    expect(await resolveContextWindowTokens('gemini', 'gemini-flash-latest')).toBe(1_048_576);
    expect(await resolveContextWindowTokens('gemini', 'gemini-3-flash-preview')).toBe(1_048_576);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('falls back for an unknown Gemini model', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('gemini', 'gemini-unknown-model');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('applies the settings override on the Gemini path too', async () => {
    contextWindowSetting = '32768';

    const window = await resolveContextWindowTokens('gemini', 'gemini-flash-latest');

    expect(window).toBe(32768);
  });

  it('gives Claude models 200k, and 1M for a [1m] model id, without fetching', async () => {
    mockCatalogueFetch();

    expect(await resolveContextWindowTokens('claude', 'claude-haiku-4-5-20251001')).toBe(200_000);
    expect(await resolveContextWindowTokens('claude', 'sonnet')).toBe(200_000);
    expect(await resolveContextWindowTokens('claude', 'claude-sonnet-4-5[1m]')).toBe(1_000_000);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('applies the settings override on the Claude path too', async () => {
    contextWindowSetting = '65536';

    expect(await resolveContextWindowTokens('claude', 'claude-haiku-4-5-20251001')).toBe(65536);
  });
});

describe('observationFieldMaxChars', () => {
  it('caps each field at a tenth of the window, never above the fixed cap', () => {
    expect(observationFieldMaxChars(16_384)).toBe(6_553);
    expect(observationFieldMaxChars(32_768)).toBe(13_107);
    expect(observationFieldMaxChars(131_072)).toBe(OBS_PROMPT_FIELD_MAX_CHARS);
    expect(observationFieldMaxChars(1_048_576)).toBe(OBS_PROMPT_FIELD_MAX_CHARS);
  });

  it('keeps the fixed cap when the window is unknown', () => {
    expect(observationFieldMaxChars(undefined)).toBe(OBS_PROMPT_FIELD_MAX_CHARS);
  });
});

describe('condenseInputMaxTokens', () => {
  it('gives a condense prompt half the window', () => {
    expect(condenseInputMaxTokens(32_768)).toBe(16_384);
    expect(condenseInputMaxTokens(FALLBACK_CONTEXT_WINDOW_TOKENS)).toBe(65_536);
    expect(condenseInputMaxTokens(1_000_000)).toBe(500_000);
  });

  it('uses the fallback window when none is known', () => {
    expect(condenseInputMaxTokens(undefined)).toBe(condenseInputMaxTokens(FALLBACK_CONTEXT_WINDOW_TOKENS));
  });
});

describe('estimateCondenseTokens', () => {
  it('reads prose at about 4 chars per token', () => {
    const prose = 'the quick brown fox jumps over the lazy dog '.repeat(2_000);
    expect(estimateCondenseTokens(prose)).toBe(Math.ceil(prose.length / 4));
  });

  it('reads a space-less run at 2.5 chars per token', () => {
    expect(estimateCondenseTokens('a'.repeat(100_000))).toBe(40_000);
  });

  it('reads JSON-escaped multi-line prose as prose', () => {
    const escaped = JSON.stringify(JSON.stringify({ stdout: 'error: cannot open\nfile not found\n'.repeat(2_000) }));
    // Only the `"{\"stdout\":\"error:` head is one dense run.
    expect(estimateCondenseTokens(escaped)).toBeLessThan(escaped.length / 4 * 1.01);
  });

  it('puts mixed text in between', () => {
    const mixed = JSON.stringify({
      log: 'GET /api/v1/items 200 '.repeat(1_000),
      blob: 'iVBORw0KGgoAAAANSUhEUg'.repeat(2_000),
    }, null, 2);
    const estimate = estimateCondenseTokens(mixed);
    expect(estimate).toBeGreaterThan(Math.ceil(mixed.length / 4));
    expect(estimate).toBeLessThan(Math.ceil(mixed.length / 2.5));
  });

  it('counts an empty string as nothing', () => {
    expect(estimateCondenseTokens('')).toBe(0);
  });
});

describe('fetchOpenRouterModelCatalog (shared with image qualification)', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    __resetContextWindowCacheForTests();
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  it('keeps id, canonical slug, alias target, modalities and parameters, and drops pricing', async () => {
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [
      { id: '~vendor/latest', alias_target: { slug: 'vendor/model' }, pricing: { prompt: '1' } },
      {
        id: 'vendor/model', canonical_slug: 'vendor/model-2026', context_length: 65536, alias_target: null,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'x' },
        supported_parameters: ['max_tokens', 'temperature'], pricing: { prompt: '1' }, top_provider: { context_length: 65536 },
      },
      { id: 'vendor/no-arch', architecture: { input_modalities: 'image' }, supported_parameters: 'max_tokens' },
      { context_length: 1 },
    ] }), { status: 200 }))) as any;

    const catalog = await fetchOpenRouterModelCatalog();
    expect(catalog?.models).toEqual([
      { id: '~vendor/latest', canonical_slug: null, alias_target: { slug: 'vendor/model' }, context_length: null, architecture: null, supported_parameters: null },
      {
        id: 'vendor/model', canonical_slug: 'vendor/model-2026', alias_target: null, context_length: 65536,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['max_tokens', 'temperature'],
      },
      { id: 'vendor/no-arch', canonical_slug: null, alias_target: null, context_length: null, architecture: null, supported_parameters: null },
    ]);
    expect(catalog?.contextLengthById.get('vendor/model')).toBe(65536);
    expect(JSON.stringify(catalog?.models)).not.toContain('pricing');
  });
});

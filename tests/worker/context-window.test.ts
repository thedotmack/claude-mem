import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager';
import {
  resolveContextWindowTokens,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  __resetContextWindowCacheForTests,
} from '../../src/services/worker/context-window';

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

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');

    expect(window).toBe(163840);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as any).mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
  });

  it('falls back when the model is absent from the catalogue', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'nonexistent/model', 'openrouter');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back when the catalogue entry has no numeric context_length', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'broken/no-window', 'openrouter');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back on a non-OK catalogue response', async () => {
    mockCatalogueFetch('upstream error', 500);

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back without throwing when fetch rejects (offline/timeout)', async () => {
    global.fetch = mock(() => Promise.reject(new Error('network down')));

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  it('serves a second call within the TTL from the cache (single fetch)', async () => {
    mockCatalogueFetch();

    const first = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');
    const second = await resolveContextWindowTokens('openrouter', 'inclusionai/ling-3.0-tiny:free', 'openrouter');

    expect(first).toBe(163840);
    expect(second).toBe(262144);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch (next call retries)', async () => {
    global.fetch = mock(() => Promise.reject(new Error('network down')));
    await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');

    mockCatalogueFetch();
    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');

    expect(window).toBe(163840);
  });

  it('lets the settings override win over the catalogue, with no fetch', async () => {
    contextWindowSetting = '200000';
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter');

    expect(window).toBe(200000);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('ignores a non-positive or non-numeric settings override', async () => {
    mockCatalogueFetch();

    contextWindowSetting = '0';
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter')).toBe(163840);

    contextWindowSetting = 'not-a-number';
    expect(await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'openrouter')).toBe(163840);
  });

  it('falls back for a custom gateway endpointClass with no fetch', async () => {
    mockCatalogueFetch();

    const window = await resolveContextWindowTokens('openrouter', 'deepseek/deepseek-v4-flash', 'custom');

    expect(window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('falls back when endpointClass is undefined, with no fetch', async () => {
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
});

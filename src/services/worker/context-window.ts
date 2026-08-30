import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { GeminiModel } from './GeminiProvider.js';

/**
 * Observer context-window resolution.
 *
 * The compaction hook needs to know how big the observer model's context
 * window is before it can decide when to compact. OpenRouter publishes this
 * per model in its public catalogue; Gemini has no catalogue, so its five
 * allowlisted models get a hardcoded map (precedent: GEMINI_RPM_LIMITS in
 * GeminiProvider.ts). Everything else — custom gateways, unknown models,
 * offline workers — falls back to a conservative constant.
 *
 * The fetch/fallback pattern is copied from fetchBlendedRates in
 * src/npx-cli/cmem-pro-costs.ts (deliberately NOT imported — npx-cli is a
 * separate entry point): plain fetch, 3s AbortSignal timeout, non-OK →
 * fallback, structural cast, bare catch → fallback. Resolution must never
 * throw; an offline worker still has to observe normally.
 */

/**
 * OpenRouter's public model catalogue. No auth required.
 *
 * Live shape verified 2026-08-08 (`curl https://openrouter.ai/api/v1/models`):
 *
 *   { "data": [ { "id": "inclusionai/ling-3.0-tiny:free",
 *                 "context_length": 262144,
 *                 "top_provider": { "context_length": 262144, ... },
 *                 "pricing": { ... }, ... }, ... ] }
 *
 * `context_length` is a top-level number on each model entry (the
 * `top_provider` copy mirrors it); that top-level field is what we parse.
 */
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Same budget as the pricing lookup: one generous GET, then fall back. */
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Used for custom gateways, models the catalogue doesn't know, and offline
 * workers. 128k is the floor for current observer-class models, so treating
 * an unknown window as 131,072 compacts too eagerly rather than overflowing.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 131_072;

/**
 * Floor for the CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW override. The compaction
 * ratios derive every budget from the window, and prompt scaffolding alone is
 * on the order of 1k tokens — below this floor no amount of payload shrinking
 * produces a fitting request (PR #3516 review), so a smaller override is a
 * misconfiguration and is clamped up with a warning. Real observer-class
 * models all have far larger windows.
 */
export const MIN_CONTEXT_WINDOW_TOKENS = 8_192;

/**
 * Gemini has no models catalogue. All five allowlisted models are Flash-family
 * with Google's documented 1M-token window. Keyed by the GeminiModel union so
 * an allowlist change breaks this map at compile time.
 */
const GEMINI_CONTEXT_WINDOWS: Record<GeminiModel, number> = {
  'gemini-flash-latest': 1_048_576,
  'gemini-flash-lite-latest': 1_048_576,
  'gemini-3.5-flash': 1_048_576,
  'gemini-3.1-flash-lite': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
};

/**
 * The catalogue is fetched at most once per TTL window (idiom:
 * telemetry.ts consentCache) and cached as the whole id → context_length map,
 * so one fetch serves every model lookup in the window. A failed fetch is
 * negative-cached for CATALOGUE_FAILURE_TTL_MS, then retried.
 */
const CATALOGUE_CACHE_TTL_MS = 60 * 60 * 1000;
let catalogueCache: { value: Map<string, number>; expiresAt: number } | null = null;

/**
 * Negative cache: after a failed fetch, every lookup falls straight back for
 * this long instead of re-hitting the catalogue. Without it, an outage makes
 * each session start wait out its own 3s timeout (PR #3516 review).
 */
const CATALOGUE_FAILURE_TTL_MS = 60_000;
let catalogueFailureUntil = 0;

/**
 * Concurrent cold lookups share one in-flight request instead of herding —
 * N session starts racing an empty cache must issue exactly one GET.
 */
let inflightCatalogueFetch: Promise<Map<string, number> | null> | null = null;

/**
 * Test-only. The catalogue cache is module state shared by the whole bun test
 * process — without a reset, a TTL test inherits whatever an earlier test
 * fetched. Never called by production code.
 */
export function __resetContextWindowCacheForTests(): void {
  catalogueCache = null;
  catalogueFailureUntil = 0;
  inflightCatalogueFetch = null;
}

/**
 * Pull the catalogue's id → context_length map, or null when it is
 * unreachable so the caller falls back. Copied from
 * cmem-pro-costs.ts fetchBlendedRates, with the structural cast widened to
 * include `context_length`.
 */
async function fetchOpenRouterContextWindows(): Promise<Map<string, number> | null> {
  const now = Date.now();
  if (catalogueCache && now < catalogueCache.expiresAt) {
    return catalogueCache.value;
  }
  if (now < catalogueFailureUntil) {
    return null;
  }
  if (inflightCatalogueFetch) {
    return inflightCatalogueFetch;
  }
  inflightCatalogueFetch = fetchCatalogueOnce().finally(() => {
    inflightCatalogueFetch = null;
  });
  return inflightCatalogueFetch;
}

async function fetchCatalogueOnce(): Promise<Map<string, number> | null> {
  try {
    const response = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      logger.debug('WORKER', 'OpenRouter catalogue returned non-OK; using fallback context window', { status: response.status });
      catalogueFailureUntil = Date.now() + CATALOGUE_FAILURE_TTL_MS;
      return null;
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; context_length?: number }>;
    };
    const byId = new Map<string, number>();
    for (const m of payload.data ?? []) {
      if (m?.id && typeof m.context_length === 'number' && m.context_length > 0) {
        byId.set(m.id, m.context_length);
      }
    }

    catalogueCache = { value: byId, expiresAt: Date.now() + CATALOGUE_CACHE_TTL_MS };
    return byId;
  } catch (err) {
    // Offline workers are normal and must not be blocked by a window lookup.
    logger.debug('WORKER', 'OpenRouter catalogue fetch failed; using fallback context window', { rawError: String(err) });
    catalogueFailureUntil = Date.now() + CATALOGUE_FAILURE_TTL_MS;
    return null;
  }
}

/**
 * Resolve the observer model's context window in tokens. Never throws.
 *
 * Order: CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW settings override (non-empty
 * positive int short-circuits everything, clamped up to
 * MIN_CONTEXT_WINDOW_TOKENS) → provider lookup (OpenRouter catalogue /
 * Gemini map) → FALLBACK_CONTEXT_WINDOW_TOKENS.
 *
 * The catalogue is only consulted for `endpointClass === 'openrouter'`: a
 * custom gateway serves models the OpenRouter catalogue knows nothing about,
 * so a lookup there would be a name collision at best.
 */
export async function resolveContextWindowTokens(
  provider: string,
  model: string,
  endpointClass?: 'openrouter' | 'custom',
): Promise<number> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const override = settings.CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW;
  if (override !== '') {
    const parsed = parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed < MIN_CONTEXT_WINDOW_TOKENS) {
        logger.warn('WORKER', 'CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW below minimum; clamping', {
          requested: parsed,
          minimum: MIN_CONTEXT_WINDOW_TOKENS,
        });
        return MIN_CONTEXT_WINDOW_TOKENS;
      }
      return parsed;
    }
  }

  if (provider === 'gemini') {
    return GEMINI_CONTEXT_WINDOWS[model as GeminiModel] ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  }

  if (endpointClass !== 'openrouter') return FALLBACK_CONTEXT_WINDOW_TOKENS;

  const byId = await fetchOpenRouterContextWindows();
  return byId?.get(model) ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
}

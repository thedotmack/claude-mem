import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isOpenRouterApiUrl } from '../../shared/openrouter-base-url.js';
import { isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import { OBS_PROMPT_FIELD_MAX_CHARS } from '../../sdk/prompts.js';
import { logger } from '../../utils/logger.js';
import type { GeminiModel } from './GeminiProvider.js';

/**
 * Observer context-window resolution.
 *
 * The observer's budgets were fixed numbers: a generation retired at 400k
 * chars and each tool field was capped at 16k chars, whatever the model. A
 * narrow-window model (a local 16k or 32k server) overflowed long before a
 * recycle triggered, and a server that truncates silently never reported the
 * overflow at all. Knowing the window lets every budget scale with it (see
 * windowAwareConversationMaxChars in shared/observer-recycle.ts and
 * observationFieldMaxChars below).
 *
 * OpenRouter publishes each model's window in its public catalogue; Gemini and
 * Claude have no catalogue, so their models get a map. Everything else
 * (custom endpoints, unknown models, offline workers) falls back to a
 * conservative constant. Resolution never throws: an offline worker still has
 * to observe normally.
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

/** One generous GET, then fall back. */
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Used for custom endpoints, models no lookup knows, and offline workers.
 * 128k is the floor for current observer-class models, so treating an unknown
 * window as 131,072 retires generations early rather than overflowing.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 131_072;

/**
 * Floor for the CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW override. Prompt
 * scaffolding alone is on the order of 1k tokens, so below this no budget
 * produces a request that fits (PR #3516 review); a smaller override is a
 * misconfiguration and is clamped up with a warning.
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

/** Claude models have a 200k window; a `[1m]` model id opts into the 1M-token window. */
const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CLAUDE_1M_MODEL_SUFFIX = /\[1m\]$/i;

/** ~4 chars per token, the estimate every observer budget already assumes. */
const CHARS_PER_TOKEN = 4;

/**
 * Share of the window one tool field may take. Two fields per observation plus
 * scaffolding stays well inside the half of the window a generation may fill.
 */
const FIELD_WINDOW_SHARE = 0.1;

export type ContextWindowProvider = 'claude' | 'gemini' | 'openrouter';

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
 * each generator start wait out its own 3s timeout (PR #3516 review).
 */
const CATALOGUE_FAILURE_TTL_MS = 60_000;
let catalogueFailureUntil = 0;

/**
 * Concurrent cold lookups share one in-flight request instead of herding —
 * N generator starts racing an empty cache must issue exactly one GET.
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

/** Pull the catalogue's id → context_length map, or null when it is unreachable. */
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
 * The CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW override, or null when unset or not a
 * whole positive number. Complete integers only: parseInt('16k') would read a
 * typo as a 16-token window.
 */
function parseContextWindowOverride(raw: unknown): number | null {
  const trimmed = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed < MIN_CONTEXT_WINDOW_TOKENS) {
    logger.warn('WORKER', 'CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW below minimum; clamping', {
      requested: parsed,
      minimum: MIN_CONTEXT_WINDOW_TOKENS,
    });
    return MIN_CONTEXT_WINDOW_TOKENS;
  }
  return parsed;
}

/**
 * Resolve the observer model's context window in tokens. Never throws.
 *
 * Order: CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW override (clamped up to
 * MIN_CONTEXT_WINDOW_TOKENS) → Claude map → Gemini map → OpenRouter catalogue
 * → FALLBACK_CONTEXT_WINDOW_TOKENS.
 *
 * The catalogue is consulted only for openrouter.ai and the cmem.ai gateway,
 * which serves OpenRouter model ids. Any other OpenAI-compatible endpoint
 * serves models the catalogue knows nothing about, so a lookup there would be
 * a name collision at best; set the override for those.
 */
export async function resolveContextWindowTokens(
  provider: ContextWindowProvider,
  model: string,
  apiUrl?: string,
): Promise<number> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const override = parseContextWindowOverride(settings.CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW);
  if (override !== null) return override;

  if (provider === 'claude') {
    return CLAUDE_1M_MODEL_SUFFIX.test(model) ? CLAUDE_1M_CONTEXT_WINDOW_TOKENS : CLAUDE_CONTEXT_WINDOW_TOKENS;
  }

  if (provider === 'gemini') {
    return GEMINI_CONTEXT_WINDOWS[model as GeminiModel] ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  }

  if (!apiUrl || !(isOpenRouterApiUrl(apiUrl) || isCmemGatewayUrl(apiUrl))) {
    return FALLBACK_CONTEXT_WINDOW_TOKENS;
  }

  const byId = await fetchOpenRouterContextWindows();
  return byId?.get(model) ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
}

/**
 * Per-field character cap for an observation prompt: a tenth of the window,
 * never above OBS_PROMPT_FIELD_MAX_CHARS. A 16k-token window gets ~6.5k chars
 * per field instead of 16k, which alone would have been half its window. An
 * unknown window keeps the fixed cap.
 */
export function observationFieldMaxChars(contextWindowTokens: number | undefined): number {
  if (!contextWindowTokens) return OBS_PROMPT_FIELD_MAX_CHARS;
  return Math.min(OBS_PROMPT_FIELD_MAX_CHARS, Math.floor(contextWindowTokens * FIELD_WINDOW_SHARE * CHARS_PER_TOKEN));
}

/**
 * Share of the window one condense prompt's payload may take: the request also
 * carries the instructions, and the condensed reply has to fit in it too.
 */
const CONDENSE_INPUT_SHARE = 0.5;

/**
 * Largest field, in chars, worth sending to the observer model in one condense
 * pass (#3800). Above it the request cannot be served (a local 32k server
 * refused 300k-631k-token condense prompts), so the field is truncated without
 * a model call. An unknown window uses the fallback window.
 */
export function condenseInputMaxChars(contextWindowTokens: number | undefined): number {
  const tokens = contextWindowTokens || FALLBACK_CONTEXT_WINDOW_TOKENS;
  return Math.floor(tokens * CHARS_PER_TOKEN * CONDENSE_INPUT_SHARE);
}

/** Output-token cap per observer reply when CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS is unset or invalid. */
export const DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS = 4096;

/** Fewer cannot hold an observation or a summary; more is a typo. */
export const OBSERVER_MAX_OUTPUT_TOKENS_BOUNDS = { min: 256, max: 1_000_000 } as const;

/**
 * The output-token cap every HTTP observer request sends (#3868): OpenRouter's
 * max_tokens, max_completion_tokens on the #4003 retry, and Gemini's
 * maxOutputTokens. A reasoning model can spend the fixed 4096 before it
 * answers, cutting replies off mid-tag; this makes the cap configurable.
 * Complete integers only; anything else keeps the default. Read per request,
 * so a settings change applies without a restart.
 */
export function resolveObserverMaxOutputTokens(settingsPath: string = USER_SETTINGS_PATH): number {
  const raw: unknown = SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS;
  const trimmed = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!/^\d+$/.test(trimmed)) return DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS;
  const parsed = Number(trimmed);
  return parsed >= OBSERVER_MAX_OUTPUT_TOKENS_BOUNDS.min && parsed <= OBSERVER_MAX_OUTPUT_TOKENS_BOUNDS.max
    ? parsed
    : DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS;
}

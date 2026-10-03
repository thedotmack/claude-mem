import { createHash } from 'node:crypto';
import { isOpenRouterApiUrl } from '../../shared/openrouter-base-url.js';
import { PROTECTED_EXTRA_BODY_KEYS } from '../../shared/openrouter-extra-body.js';
import { isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import { MEDIA_LIMITS } from '../../shared/media-contract.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { fetchOpenRouterModelCatalog, type OpenRouterCatalogModel } from './context-window.js';

/**
 * Image-input capability for the observer request (docs/media-contract-v1.md,
 * "Capability qualification" and "Pro gateway capability endpoint").
 *
 * - Direct openrouter.ai: the configured model and every fallback must
 *   resolve in the public catalogue to a model with image input, text output
 *   and every parameter the worker sends on an image turn.
 * - The cmem gateway: only its capability response counts, because the server
 *   overrides the client's model.
 * - Any other base URL: unsupported in v1, never receives images.
 *
 * Every failure is a reason, never an exception: an unqualified turn is sent
 * as today's text-only request and its images stay uninspected.
 */

export type ImageCapabilityReason =
  | 'inference_disabled'
  | 'model_not_image_capable'
  | 'model_unresolved'
  | 'missing_parameters'
  | 'catalog_unavailable'
  /** Local only: a base URL that is neither openrouter.ai nor the cmem gateway. */
  | 'endpoint_unsupported';

/** The per-request image bounds the caller must stay within (snake_case, the gateway wire shape). */
export interface ImageRequestBounds {
  max_images_per_request: number;
  max_image_decoded_bytes: number;
  max_aggregate_image_decoded_bytes: number;
  max_aggregate_image_data_url_bytes: number;
  max_image_dimension: number;
  max_body_bytes: number;
  image_mime_types: string[];
}

export type ImageCapability =
  | { supported: true; bounds: ImageRequestBounds }
  | { supported: false; reason: ImageCapabilityReason };

const WEBP_DATA_URL_PREFIX = 'data:image/webp;base64,';
const MAX_IMAGE_DATA_URL_CHARS = WEBP_DATA_URL_PREFIX.length + 4 * Math.ceil(MEDIA_LIMITS.maxDerivativeBytes / 3);

/** The frozen v1 per-request bounds; the direct-OpenRouter lane uses them as is. */
export const LOCAL_IMAGE_REQUEST_BOUNDS: Readonly<ImageRequestBounds> = Object.freeze({
  max_images_per_request: MEDIA_LIMITS.maxImagesPerEvent,
  max_image_decoded_bytes: MEDIA_LIMITS.maxDerivativeBytes,
  max_aggregate_image_decoded_bytes: MEDIA_LIMITS.maxGatewayImageBytes,
  max_aggregate_image_data_url_bytes: MEDIA_LIMITS.maxImagesPerEvent * MAX_IMAGE_DATA_URL_CHARS,
  max_image_dimension: MEDIA_LIMITS.maxDerivativeDimension,
  max_body_bytes: 4 * 1024 * 1024,
  image_mime_types: ['image/webp'],
});

/** Whether CLAUDE_MEM_MEDIA_INFERENCE_ENABLED is on. Independent of the capture flag; off by default. */
export function isMediaInferenceEnabled(settingsPath: string = USER_SETTINGS_PATH): boolean {
  return SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_MEDIA_INFERENCE_ENABLED === 'true';
}

/**
 * Copy of Pro `resolveCatalogModel` (src/lib/pro/observer-model-policy.ts):
 * look up by id, then canonical_slug, and follow alias_target.slug. A missing
 * target, a cycle, or a chain ending on a `~` id resolves to null.
 */
export function resolveCatalogModel(models: OpenRouterCatalogModel[], id: string): OpenRouterCatalogModel | null {
  const visited = new Set<string>();
  let target = id.trim();
  while (target) {
    const model = models.find(candidate => candidate.id === target)
      ?? models.find(candidate => candidate.canonical_slug === target);
    if (!model || visited.has(model.id)) return null;
    visited.add(model.id);
    if (model.alias_target == null) {
      return model.id.startsWith('~') ? null : model;
    }
    target = typeof model.alias_target.slug === 'string' ? model.alias_target.slug.trim() : '';
  }
  return null;
}

export interface CatalogQualification {
  resolved_model: string | null;
  supports_image_input: boolean;
  reason: ImageCapabilityReason | null;
}

function qualifyOne(models: OpenRouterCatalogModel[], requested: string, requiredParameters: readonly string[]): CatalogQualification {
  const resolved = resolveCatalogModel(models, requested);
  if (!resolved) return { resolved_model: null, supports_image_input: false, reason: 'model_unresolved' };
  const architecture = resolved.architecture;
  if (!architecture?.input_modalities.includes('image') || !architecture.output_modalities.includes('text')) {
    return { resolved_model: resolved.id, supports_image_input: false, reason: 'model_not_image_capable' };
  }
  const supported = resolved.supported_parameters;
  if (!supported || requiredParameters.some(parameter => !supported.includes(parameter))) {
    return { resolved_model: resolved.id, supports_image_input: false, reason: 'missing_parameters' };
  }
  return { resolved_model: resolved.id, supports_image_input: true, reason: null };
}

/**
 * Qualify a model, or a primary plus fallbacks, against catalogue entries.
 * OpenRouter may route to any model in the list, so every one must qualify;
 * the result names the primary's resolved model and the first failure.
 */
export function qualifyCatalogModels(
  models: OpenRouterCatalogModel[],
  requested: string | readonly string[],
  requiredParameters: readonly string[],
): CatalogQualification {
  const list = typeof requested === 'string' ? [requested] : [...requested];
  if (list.length === 0) return { resolved_model: null, supports_image_input: false, reason: 'model_unresolved' };
  const results = list.map(model => qualifyOne(models, model, requiredParameters));
  const failure = results.find(result => !result.supports_image_input);
  return {
    resolved_model: results[0].resolved_model,
    supports_image_input: !failure,
    reason: failure ? failure.reason : null,
  };
}

/**
 * CLAUDE_MEM_OPENROUTER_EXTRA_BODY keys that are OpenRouter request options
 * (routing, accounting, plugins) rather than model parameters; the Models API
 * never lists them in supported_parameters.
 */
const OPENROUTER_REQUEST_OPTION_KEYS: readonly string[] = [
  'provider', 'transforms', 'route', 'usage', 'plugins', 'user', 'session_id', 'models',
];

/**
 * The OpenRouter parameters the local worker sends on an image (observation)
 * turn: max_tokens and temperature always; reasoning when the typed
 * CLAUDE_MEM_OPENROUTER_REASONING_EFFORT is sent; and every model parameter
 * CLAUDE_MEM_OPENROUTER_EXTRA_BODY adds (openrouter.ai only, as the request
 * body merges it). The max_completion_tokens compatibility retry is never
 * sent with images: an image request that needs it is resent text-only.
 */
export function localImageTurnParameters(input: { apiUrl: string; reasoningEffort?: string; extraBody?: Record<string, unknown> }): string[] {
  const parameters = ['max_tokens', 'temperature'];
  if (!isOpenRouterApiUrl(input.apiUrl)) return parameters;
  if (input.reasoningEffort !== undefined) parameters.push('reasoning');
  for (const key of Object.keys(input.extraBody ?? {})) {
    if (PROTECTED_EXTRA_BODY_KEYS.includes(key) || OPENROUTER_REQUEST_OPTION_KEYS.includes(key)) continue;
    if (key === 'reasoning' && input.reasoningEffort !== undefined) continue;
    if (!parameters.includes(key)) parameters.push(key);
  }
  return parameters;
}

// ---------------------------------------------------------------------------
// cmem gateway capability response
// ---------------------------------------------------------------------------

const GATEWAY_CAPABILITY_FAILURE_TTL_MS = 60_000;
const GATEWAY_CAPABILITY_MAX_TTL_MS = 60 * 60 * 1000;
const GATEWAY_CAPABILITY_TIMEOUT_MS = 3_000;
const GATEWAY_REASONS: readonly string[] = [
  'inference_disabled', 'model_not_image_capable', 'model_unresolved', 'missing_parameters', 'catalog_unavailable',
];
const RESPONSE_KEYS = [
  'version', 'requested_model', 'resolved_model', 'supports_image_input', 'reason', 'bounds', 'qualified_at', 'ttl_seconds',
].sort().join(',');
const BOUNDS_KEYS = [
  'max_images_per_request', 'max_image_decoded_bytes', 'max_aggregate_image_decoded_bytes',
  'max_aggregate_image_data_url_bytes', 'max_image_dimension', 'max_body_bytes', 'image_mime_types',
].sort().join(',');

interface GatewayCapabilityEntry { value: ImageCapability; expiresAt: number }
const gatewayCapabilityCache = new Map<string, GatewayCapabilityEntry>();
const inflightGatewayCapability = new Map<string, Promise<ImageCapability>>();

/** Test-only reset seam for the gateway capability cache. Never called by production code. */
export function __resetMediaCapabilityCacheForTests(): void {
  gatewayCapabilityCache.clear();
  inflightGatewayCapability.clear();
}

/** `<base>/chat/completions` → `<base>/capabilities`, keeping any query string. */
export function gatewayCapabilitiesUrl(chatCompletionsUrl: string): string {
  const url = new URL(chatCompletionsUrl);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '') + '/capabilities';
  return url.toString();
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseGatewayBounds(value: unknown): ImageRequestBounds | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const bounds = value as Record<string, unknown>;
  if (Object.keys(bounds).sort().join(',') !== BOUNDS_KEYS) return null;
  const numeric = [
    bounds.max_images_per_request, bounds.max_image_decoded_bytes, bounds.max_aggregate_image_decoded_bytes,
    bounds.max_aggregate_image_data_url_bytes, bounds.max_image_dimension, bounds.max_body_bytes,
  ];
  if (!numeric.every(isPositiveInteger)) return null;
  if (!Array.isArray(bounds.image_mime_types) || !bounds.image_mime_types.every(mime => typeof mime === 'string')) return null;
  return {
    max_images_per_request: bounds.max_images_per_request as number,
    max_image_decoded_bytes: bounds.max_image_decoded_bytes as number,
    max_aggregate_image_decoded_bytes: bounds.max_aggregate_image_decoded_bytes as number,
    max_aggregate_image_data_url_bytes: bounds.max_aggregate_image_data_url_bytes as number,
    max_image_dimension: bounds.max_image_dimension as number,
    max_body_bytes: bounds.max_body_bytes as number,
    image_mime_types: [...bounds.image_mime_types as string[]],
  };
}

/**
 * Parse a capability response body strictly. Anything that is not the exact
 * version-1 shape returns null, which the caller treats as unavailable.
 */
export function parseGatewayCapabilityResponse(body: unknown): { capability: ImageCapability; ttlMs: number } | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== RESPONSE_KEYS || record.version !== 1) return null;
  if (typeof record.requested_model !== 'string') return null;
  if (record.resolved_model !== null && typeof record.resolved_model !== 'string') return null;
  if (typeof record.supports_image_input !== 'boolean' || !isPositiveInteger(record.ttl_seconds)) return null;
  if (record.qualified_at !== null && typeof record.qualified_at !== 'string') return null;
  const ttlMs = Math.min(record.ttl_seconds * 1000, GATEWAY_CAPABILITY_MAX_TTL_MS);

  if (record.supports_image_input) {
    if (record.reason !== null) return null;
    const bounds = parseGatewayBounds(record.bounds);
    if (!bounds) return null;
    return { capability: { supported: true, bounds }, ttlMs };
  }
  if (record.bounds !== null || typeof record.reason !== 'string' || !GATEWAY_REASONS.includes(record.reason)) return null;
  return { capability: { supported: false, reason: record.reason as ImageCapabilityReason }, ttlMs };
}

async function fetchGatewayCapabilityOnce(capabilitiesUrl: string, apiKey: string): Promise<{ capability: ImageCapability; ttlMs: number }> {
  const unavailable = { capability: { supported: false, reason: 'catalog_unavailable' } as ImageCapability, ttlMs: GATEWAY_CAPABILITY_FAILURE_TTL_MS };
  try {
    const response = await fetch(capabilitiesUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(GATEWAY_CAPABILITY_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn('WORKER', 'cmem gateway capability request failed; images stay uninspected', { code: 'gateway_http_status', status: response.status });
      return unavailable;
    }
    const parsed = parseGatewayCapabilityResponse(await response.json());
    if (!parsed) {
      logger.warn('WORKER', 'cmem gateway capability response was malformed; images stay uninspected', { code: 'gateway_malformed_response' });
      return unavailable;
    }
    return parsed;
  } catch (error) {
    // Network error, timeout or unparseable body: deferred, never an observer failure.
    const name = error instanceof Error ? error.name : 'unknown';
    const code = name === 'TimeoutError' || name === 'AbortError' ? 'gateway_timeout'
      : name === 'SyntaxError' ? 'gateway_malformed_response' : 'gateway_network_error';
    logger.warn('WORKER', 'cmem gateway capability request did not complete; images stay uninspected', { code });
    return unavailable;
  }
}

/**
 * The gateway's capability response, cached for its ttl_seconds (60 s for any
 * failure), with one request in flight per base URL and key.
 */
export async function fetchGatewayImageCapability(chatCompletionsUrl: string, apiKey: string): Promise<ImageCapability> {
  const capabilitiesUrl = gatewayCapabilitiesUrl(chatCompletionsUrl);
  const cacheKey = `${capabilitiesUrl}\n${createHash('sha256').update(apiKey).digest('hex')}`;
  const cached = gatewayCapabilityCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const inflight = inflightGatewayCapability.get(cacheKey);
  if (inflight) return inflight;
  const request = fetchGatewayCapabilityOnce(capabilitiesUrl, apiKey)
    .then(({ capability, ttlMs }) => {
      gatewayCapabilityCache.set(cacheKey, { value: capability, expiresAt: Date.now() + ttlMs });
      return capability;
    })
    .finally(() => inflightGatewayCapability.delete(cacheKey));
  inflightGatewayCapability.set(cacheKey, request);
  return request;
}

// ---------------------------------------------------------------------------
// Resolution for one observer request
// ---------------------------------------------------------------------------

export interface ObserverImageCapabilityInput {
  apiUrl: string;
  apiKey: string;
  model: string;
  fallbackModels: readonly string[];
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
}

/**
 * Whether this observer request may carry images, and within which bounds.
 * Never throws; every failure is a reason.
 */
export async function resolveObserverImageCapability(
  input: ObserverImageCapabilityInput,
  settingsPath: string = USER_SETTINGS_PATH,
): Promise<ImageCapability> {
  if (!isMediaInferenceEnabled(settingsPath)) return { supported: false, reason: 'inference_disabled' };

  if (isCmemGatewayUrl(input.apiUrl)) {
    if (!input.apiKey) return { supported: false, reason: 'catalog_unavailable' };
    return fetchGatewayImageCapability(input.apiUrl, input.apiKey);
  }

  if (!isOpenRouterApiUrl(input.apiUrl)) return { supported: false, reason: 'endpoint_unsupported' };

  const catalog = await fetchOpenRouterModelCatalog();
  if (!catalog) return { supported: false, reason: 'catalog_unavailable' };
  const qualification = qualifyCatalogModels(
    catalog.models,
    [input.model, ...input.fallbackModels],
    localImageTurnParameters(input),
  );
  if (!qualification.supports_image_input) {
    return { supported: false, reason: qualification.reason ?? 'model_not_image_capable' };
  }
  return { supported: true, bounds: { ...LOCAL_IMAGE_REQUEST_BOUNDS } };
}

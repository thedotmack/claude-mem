/**
 * OpenCode's `provider` config declares each provider's models as
 * `provider[providerID].models[modelID]`. The host's selected model is written
 * `providerID/modelID`, which is a display key, not an endpoint model name (see
 * the `ChatMessageInput.model` comment in `src/integrations/opencode-plugin/v1.ts`).
 * This module turns the former into the latter, and nothing else: it is pure,
 * takes no network action, and never invents a model.
 */

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * The model id an OpenAI-compatible endpoint accepts for `hostModelId`, or
 * `undefined` when it cannot be known from `providerConfig`.
 *
 * `hostModelId` is split at its first `/`: everything before is the provider
 * id, everything after is the model key (which may itself contain slashes, as
 * OpenRouter model ids do). A V2 entry carries the endpoint id in `modelID`; a
 * V1 entry may carry it in `id`; otherwise the map key is already endpoint
 * ready. An absent provider, an unknown model, a missing slash, or any
 * non-object level yields `undefined` so the caller keeps its own default.
 */
export function resolveEndpointModelId(
  hostModelId: string,
  providerConfig: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof hostModelId !== 'string') return undefined;
  const slash = hostModelId.indexOf('/');
  if (slash <= 0 || slash === hostModelId.length - 1) return undefined;

  const providerID = hostModelId.slice(0, slash);
  const modelID = hostModelId.slice(slash + 1);

  const provider = plainObject(providerConfig?.[providerID]);
  const models = plainObject(provider?.models);
  if (!models || !Object.hasOwn(models, modelID)) return undefined;

  const model = plainObject(models[modelID]);
  if (!model) return undefined;

  return nonEmptyString(model.modelID) ?? nonEmptyString(model.id) ?? modelID;
}

/**
 * The endpoint base a provider URL names, or `undefined` for a non-URL value.
 *
 * The observer's `apiUrl` already names `/chat/completions`; a provider's
 * `baseURL` may name the base, the same base with a trailing slash, or the full
 * completions URL. Reduce all three forms to the same base before comparing.
 * The scheme and host are case-insensitive (URL() canonicalizes them), the path
 * is not, and a query or fragment is part of the endpoint's identity.
 */
function normalizedEndpointBase(rawUrl: unknown): string | undefined {
  const value = nonEmptyString(rawUrl);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const path = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/i, '')
      .replace(/\/+$/, '');
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * The endpoint-ready id for `hostModelId`, with whether it came from the
 * provider's own identity instead of a strict model mapping.
 *
 * Strict translation always wins: an id declared in `provider.models` is sent
 * as that entry's endpoint id, never as its display key. Only when that fails
 * may the display key itself be the endpoint's id — and only when the provider
 * named by the prefix declares a normalized base URL equal to `apiUrl`. This
 * covers host providers whose built-in models are not listed in `models` but
 * whose keys are already endpoint-ready (an OpenRouter-style multi-segment key
 * keeps its slashes). A provider pointing elsewhere, an absent provider, or a
 * missing slash yields `undefined`: the caller keeps its own fallback rather
 * than inventing an id for an endpoint that never declared it.
 *
 * Pure: reads only the config already loaded by the host reader, makes no
 * network request, and never mutates `providerConfig`.
 */
export function resolveEndpointModelIdWithIdentity(
  hostModelId: string,
  providerConfig: Record<string, unknown> | undefined,
  apiUrl: string | undefined,
): { id: string; identity: boolean } | undefined {
  const mapped = resolveEndpointModelId(hostModelId, providerConfig);
  if (mapped) return { id: mapped, identity: false };

  if (!apiUrl || typeof hostModelId !== 'string') return undefined;
  const slash = hostModelId.indexOf('/');
  if (slash <= 0 || slash === hostModelId.length - 1) return undefined;

  const provider = plainObject(providerConfig?.[hostModelId.slice(0, slash)]);
  if (!provider) return undefined;
  const options = plainObject(provider.options);
  const endpointBase = normalizedEndpointBase(apiUrl);
  if (!endpointBase) return undefined;
  const declared = [provider.baseURL, provider.baseUrl, options?.baseURL];
  if (!declared.some(value => normalizedEndpointBase(value) === endpointBase)) return undefined;

  return { id: hostModelId.slice(slash + 1), identity: true };
}

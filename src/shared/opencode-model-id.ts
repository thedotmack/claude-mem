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

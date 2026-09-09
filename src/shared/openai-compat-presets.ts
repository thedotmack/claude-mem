// SPDX-License-Identifier: Apache-2.0

/**
 * Endpoint presets for the `openai-compatible` provider.
 *
 * WHY THIS IS NOT JUST CLAUDE_MEM_OPENROUTER_BASE_URL. That setting already
 * turns the OpenRouter client into a generic OpenAI-compatible client, and it
 * is how people reach DeepSeek and LM Studio today. But it does so by riding
 * inside the OpenRouter provider, which carries three things that belong to
 * openrouter.ai and to the cmem.ai gateway specifically:
 *
 *   1. `HTTP-Referer` / `X-Title` attribution headers, which are sent to
 *      whatever host the base URL names. Pointing that at NVIDIA means
 *      claude-mem's OpenRouter leaderboard identity is announced to NVIDIA.
 *   2. `usage: { include: true }`, gated on the URL containing `openrouter.ai`
 *      — one special case that has to keep growing per endpoint.
 *   3. The cmem-gateway tuple locking in `resolveOpenRouterConfig`: a
 *      deliberately intricate set of rules about when a persisted base URL
 *      pins a persisted key, so an account-delivered gateway credential is
 *      never sent to a host the user just repointed. Every one of those rules
 *      is correct and none of them mean anything for a self-configured
 *      endpoint — but a user reaching NVIDIA still has to reason about them,
 *      because their config shares the same three settings keys.
 *
 * So a third-party endpoint gets its own provider id and its own settings,
 * built on the same `OpenAICompatibleProvider` scaffolding. Nothing about the
 * OpenRouter path changes, and `CLAUDE_MEM_OPENROUTER_BASE_URL` keeps working
 * for anyone already using it.
 *
 * A preset is only a default base URL plus a default model — everything a
 * preset sets can be overridden by the matching setting. `custom` (or an empty
 * preset) means "I will supply the base URL myself", which is the escape hatch
 * for any endpoint not listed here.
 */

export interface OpenAICompatPreset {
  id: string;
  /** Shown in the installer and the settings UI. */
  label: string;
  /** OpenAI-compatible base URL. Empty for `custom`. */
  baseUrl: string;
  /**
   * Model used when CLAUDE_MEM_OPENAI_COMPAT_MODEL is unset. Empty when there
   * is no sensible default (a local server serves whatever the user loaded).
   */
  defaultModel: string;
  /** False for local servers that accept any bearer token, or none. */
  requiresApiKey: boolean;
  /** One line for the installer/docs. */
  hint: string;
}

export const OPENAI_COMPAT_PRESETS: readonly OpenAICompatPreset[] = [
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM (build.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // A small, fast model: observation extraction is a high-volume structured
    // task, not a reasoning benchmark. Override with any id from
    // build.nvidia.com — the value is passed verbatim.
    defaultModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    requiresApiKey: true,
    hint: 'Free hosted inference across NVIDIA-served models. Key starts with nvapi- from build.nvidia.com.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    hint: 'Answers the case #2622 raised, without borrowing the OpenRouter settings keys.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: '',
    requiresApiKey: true,
    hint: 'Very fast; pick a model id from console.groq.com.',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: '',
    requiresApiKey: true,
    hint: 'Pick a model id from api.together.ai/models.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    requiresApiKey: false,
    hint: 'Local and free. Set the model to whatever `ollama list` shows.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    requiresApiKey: false,
    hint: 'Local and free. Ships no default model, so nothing is auto-loaded that the user did not ask for (#2393).',
  },
  {
    id: 'vllm',
    label: 'vLLM (self-hosted)',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: '',
    requiresApiKey: false,
    hint: 'Self-hosted OpenAI-compatible server.',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: '',
    defaultModel: '',
    requiresApiKey: false,
    hint: 'Set CLAUDE_MEM_OPENAI_COMPAT_BASE_URL and _MODEL by hand.',
  },
] as const;

export const DEFAULT_OPENAI_COMPAT_PRESET_ID = 'custom';

/**
 * Look up a preset by id. An unknown or empty id resolves to `custom` rather
 * than throwing: a typo in settings.json should degrade to "configure it by
 * hand", which then fails with a message naming the base URL, not to a crash
 * on a settings read that happens during status polling.
 */
export function resolveOpenAICompatPreset(id: unknown): OpenAICompatPreset {
  const wanted = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!wanted) return getPreset(DEFAULT_OPENAI_COMPAT_PRESET_ID);
  return OPENAI_COMPAT_PRESETS.find(preset => preset.id === wanted)
    ?? getPreset(DEFAULT_OPENAI_COMPAT_PRESET_ID);
}

function getPreset(id: string): OpenAICompatPreset {
  const preset = OPENAI_COMPAT_PRESETS.find(entry => entry.id === id);
  if (!preset) throw new Error(`Unknown openai-compatible preset "${id}"`);
  return preset;
}

/** Preset ids, for validation messages and the installer list. */
export function openAICompatPresetIds(): string[] {
  return OPENAI_COMPAT_PRESETS.map(preset => preset.id);
}

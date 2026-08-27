import type { SettingsDefaults } from '../shared/SettingsDefaultsManager.js';
import { isCmemGatewayUrl } from '../shared/cmem-gateway.js';
import { CMEM_PRO_BASE_URL, CMEM_PRO_MODEL } from './cmem-pro-costs.js';

export interface DeliveredCmemMemoryCredentials {
  memoryKey: string;
  memoryBaseUrl: string;
  memoryModel: string;
}

export interface ResolvedCmemMemoryCredentials extends DeliveredCmemMemoryCredentials {
  source: 'fresh' | 'staged' | 'configured';
  /** Fresh material may safely retry the gateway and reset the notice marker. */
  clearFallback: boolean;
}

type SettingsLike = Partial<Record<keyof SettingsDefaults, unknown>>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the account-owned cmem gateway key without consulting environment
 * overrides (callers pass the raw settings document). Priority is deliberate:
 * this run's one-shot delivery, then staged delivery, then an already-active
 * cmem OpenRouter configuration from an earlier install.
 */
export function resolveCmemMemoryCredentials(
  delivered: DeliveredCmemMemoryCredentials | null,
  settings: SettingsLike,
): ResolvedCmemMemoryCredentials | null {
  if (delivered) {
    return {
      memoryKey: delivered.memoryKey,
      memoryBaseUrl: delivered.memoryBaseUrl,
      memoryModel: delivered.memoryModel,
      source: 'fresh',
      clearFallback: true,
    };
  }

  const stagedKey = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_KEY);
  if (stagedKey) {
    return {
      memoryKey: stagedKey,
      memoryBaseUrl: nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_BASE_URL) ?? CMEM_PRO_BASE_URL,
      memoryModel: nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_MODEL) ?? CMEM_PRO_MODEL,
      source: 'staged',
      // A staged key moved out of a failed configured slot retains the marker;
      // a newly delivered key clears it in completeTrialPairing.
      clearFallback: !nonEmptyString(settings.CLAUDE_MEM_PRO_FALLBACK_AT),
    };
  }

  const configuredKey = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_API_KEY);
  const configuredBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  if (configuredKey && configuredBaseUrl && isCmemGatewayUrl(configuredBaseUrl)) {
    return {
      memoryKey: configuredKey,
      memoryBaseUrl: configuredBaseUrl,
      memoryModel: nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_MODEL) ?? CMEM_PRO_MODEL,
      source: 'configured',
      // Merely rerunning install is not evidence that a rejected key is funded
      // again. Keep fallback active until fresh material or a gateway probe.
      clearFallback: false,
    };
  }

  return null;
}

/** Atomically move staged/current credentials into the active provider slot. */
export function buildCmemActivationSettings(
  credentials: ResolvedCmemMemoryCredentials,
): Record<string, string> {
  return {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_BASE_URL: credentials.memoryBaseUrl,
    CLAUDE_MEM_OPENROUTER_MODEL: credentials.memoryModel,
    CLAUDE_MEM_OPENROUTER_API_KEY: credentials.memoryKey,
    CLAUDE_MEM_PRO_MEMORY_KEY: '',
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: '',
    CLAUDE_MEM_PRO_MEMORY_MODEL: '',
    ...(credentials.clearFallback ? { CLAUDE_MEM_PRO_FALLBACK_AT: '' } : {}),
  };
}

/**
 * Switch from the cmem gateway to a personal OpenRouter key without ever
 * combining that personal key with cmem's endpoint/model. If the active slot
 * contains the only cmem key, move it back to staging before replacing it.
 */
export function buildPersonalOpenRouterSettings(
  apiKey: string,
  settings: SettingsLike,
  defaultOpenRouterModel: string,
): Record<string, string> {
  let stagedKey = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_KEY) ?? '';
  let stagedBaseUrl = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_BASE_URL) ?? '';
  let stagedModel = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_MODEL) ?? '';

  const configuredKey = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_API_KEY);
  const configuredBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  if (!stagedKey && configuredKey && configuredBaseUrl && isCmemGatewayUrl(configuredBaseUrl)) {
    stagedKey = configuredKey;
    stagedBaseUrl = configuredBaseUrl;
    stagedModel = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_MODEL) ?? CMEM_PRO_MODEL;
  }

  return {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_API_KEY: apiKey.trim(),
    CLAUDE_MEM_OPENROUTER_BASE_URL: '',
    CLAUDE_MEM_OPENROUTER_MODEL: defaultOpenRouterModel,
    CLAUDE_MEM_PRO_MEMORY_KEY: stagedKey,
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: stagedBaseUrl,
    CLAUDE_MEM_PRO_MEMORY_MODEL: stagedModel,
  };
}

/**
 * Make `--provider openrouter` safe when a previous interactive install left
 * a cmem gateway configuration active. The flag cannot prompt for a personal
 * key, so move the cmem key back to staging and clear its endpoint/model from
 * the generic slot. A key supplied later through the environment will then use
 * OpenRouter's normal endpoint instead of being sent to cmem.ai.
 */
export function buildNonInteractiveOpenRouterSettings(
  settings: SettingsLike,
  defaultOpenRouterModel: string,
): Record<string, string> {
  const configuredBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  if (!configuredBaseUrl || !isCmemGatewayUrl(configuredBaseUrl)) {
    return { CLAUDE_MEM_PROVIDER: 'openrouter' };
  }

  return buildPersonalOpenRouterSettings('', settings, defaultOpenRouterModel);
}

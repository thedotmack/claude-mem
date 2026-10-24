// SPDX-License-Identifier: Apache-2.0

/**
 * The health endpoint's authMethod. It used to describe the Claude credential
 * for every provider except Codex, so an OpenRouter or Gemini install was
 * reported as "Claude Code OAuth token".
 */

import { isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import { getAuthMethodDescription } from '../../shared/EnvManager.js';
import { resolveOpenAICompatPreset } from '../../shared/openai-compat-presets.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';

/**
 * The base URL resolveOpenRouterConfig will actually call. A persisted cmem
 * tuple stays pinned unless CLAUDE_MEM_OPENROUTER_BASE_URL is set in the
 * environment. Otherwise an empty settings URL falls through to
 * OPENROUTER_BASE_URL, the same fallback the provider sends to.
 */
function resolvedOpenRouterBaseUrl(settings: SettingsDefaults, persistedBaseUrl: string): string {
  const persisted = persistedBaseUrl.trim();
  const hasBaseOverride = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_MEM_OPENROUTER_BASE_URL');
  if (isCmemGatewayUrl(persisted) && !hasBaseOverride) return persisted;
  const configured = typeof settings.CLAUDE_MEM_OPENROUTER_BASE_URL === 'string'
    ? settings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim()
    : '';
  return configured || process.env.OPENROUTER_BASE_URL?.trim() || '';
}

export function describeObserverAuthMethod(provider: string, settings?: SettingsDefaults): string {
  const resolved = settings ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // A caller that passes settings already chose the values to name. Reading the
  // on-disk file here would let a persisted cmem tuple override that, and the
  // unit tests would depend on whatever settings.json this machine has.
  const persistedBaseUrl = settings
    ? ''
    : String(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false).CLAUDE_MEM_OPENROUTER_BASE_URL ?? '');
  switch (provider) {
    case 'codex':
      return 'Codex CLI subscription';
    case 'gemini':
      return 'Gemini API key';
    case 'openrouter':
      return isCmemGatewayUrl(resolvedOpenRouterBaseUrl(resolved, persistedBaseUrl))
        ? 'cmem.ai gateway'
        : 'OpenRouter API key';
    case 'openai-compatible': {
      const preset = resolveOpenAICompatPreset(resolved.CLAUDE_MEM_OPENAI_COMPAT_PRESET);
      return preset.id === 'custom'
        ? 'OpenAI-compatible API key'
        : `${preset.label} API key`;
    }
    default:
      return getAuthMethodDescription();
  }
}

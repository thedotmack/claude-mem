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

export function describeObserverAuthMethod(provider: string, settings?: SettingsDefaults): string {
  const resolved = settings ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  switch (provider) {
    case 'codex':
      return 'Codex CLI subscription';
    case 'gemini':
      return 'Gemini API key';
    case 'openrouter':
      return isCmemGatewayUrl(resolved.CLAUDE_MEM_OPENROUTER_BASE_URL)
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

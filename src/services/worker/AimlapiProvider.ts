// SPDX-License-Identifier: Apache-2.0

/**
 * The `aimlapi` provider: aimlapi.com's OpenAI-compatible chat-completions
 * API, on its own provider id and its own CLAUDE_MEM_AIMLAPI_* settings.
 *
 * It is the `openai-compatible` provider with three things filled in: the
 * endpoint (https://api.aimlapi.com/v1 unless CLAUDE_MEM_AIMLAPI_BASE_URL says
 * otherwise), a default model, and aimlapi.com's attribution headers. The
 * request, streaming, key rotation, retries and error classification are the
 * openai-compatible provider's, unchanged.
 *
 * The attribution headers go to aimlapi.com only (aimlapiRequestHeaders): a
 * base URL pointed anywhere else gets a plain request.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { keysForEndpoint } from '../../shared/cmem-gateway.js';
import { buildKeyPool } from '../../shared/api-key-pool.js';
import { AIMLAPI_DEFAULT_BASE_URL, AIMLAPI_DEFAULT_MODEL, resolveAimlapiApiKey, resolveAimlapiChatCompletionsUrl } from '../../shared/aimlapi-base-url.js';
import { aimlapiRequestHeaders, isAimlapiHost } from '../../shared/aimlapi-attribution.js';
import type { OpenAICompatPreset } from '../../shared/openai-compat-presets.js';
import type { ActiveSession } from '../worker-types.js';
import { logger } from '../../utils/logger.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { OpenAICompatProvider, isLocalEndpointUrl, type OpenAICompatConfig } from './OpenAICompatProvider.js';

const AIMLAPI_PRESET: OpenAICompatPreset = {
  id: 'aimlapi',
  label: 'aimlapi.com',
  baseUrl: AIMLAPI_DEFAULT_BASE_URL,
  defaultModel: AIMLAPI_DEFAULT_MODEL,
  requiresApiKey: true,
  hint: 'One aimlapi.com key for its chat models; model ids are passed verbatim.',
};

/** Endpoint the attribution headers were last withheld from, so a status poll logs it once. */
let lastNonAimlapiUrl: string | null = null;

export function resolveAimlapiConfig(settingsPath: string = USER_SETTINGS_PATH): OpenAICompatConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const configuredBaseUrl = (settings.CLAUDE_MEM_AIMLAPI_BASE_URL ?? '').trim();
  const apiUrl = resolveAimlapiChatCompletionsUrl(configuredBaseUrl);
  const model = (settings.CLAUDE_MEM_AIMLAPI_MODEL ?? '').trim() || AIMLAPI_DEFAULT_MODEL;
  // The shared cmem key lock (#4276): a cm_pro_ memory key never leaves for
  // aimlapi.com, and no aimlapi key is ever sent to the cmem gateway.
  const apiKeys = keysForEndpoint(apiUrl, buildKeyPool(resolveAimlapiApiKey(settings), ''));
  if (!isAimlapiHost(apiUrl) && lastNonAimlapiUrl !== apiUrl) {
    lastNonAimlapiUrl = apiUrl;
    logger.info('SDK', 'CLAUDE_MEM_AIMLAPI_BASE_URL is not an aimlapi.com host; sending requests without the aimlapi.com attribution headers', { apiUrl });
  }
  return {
    apiKey: apiKeys[0] ?? '',
    apiKeys,
    model,
    apiUrl,
    preset: AIMLAPI_PRESET,
    requiresApiKey: configuredBaseUrl ? !isLocalEndpointUrl(configuredBaseUrl) : true,
    extraHeaders: aimlapiRequestHeaders(
      apiUrl,
      (settings.CLAUDE_MEM_AIMLAPI_SITE_URL ?? '').trim(),
      (settings.CLAUDE_MEM_AIMLAPI_APP_NAME ?? '').trim(),
    ),
    settingsPrefix: 'CLAUDE_MEM_AIMLAPI',
  };
}

export class AimlapiProvider extends OpenAICompatProvider {
  protected readonly providerName = 'aimlapi.com';
  protected readonly syntheticIdPrefix = 'aimlapi';
  protected readonly keyPoolId = 'aimlapi' as const;

  protected getConfig(): OpenAICompatConfig {
    return resolveAimlapiConfig(paths.settings());
  }

  protected missingApiKeyError(): Error {
    return new ClassifiedProviderError(
      'aimlapi.com API key not configured. Set CLAUDE_MEM_AIMLAPI_API_KEY in settings, or AIMLAPI_API_KEY in the environment or ~/.claude-mem/.env.',
      { kind: 'setup_required', cause: new Error('missing api key') },
    );
  }

  protected prepareSessionExtras(session: ActiveSession, config: OpenAICompatConfig): void {
    session.endpointClass = isAimlapiHost(config.apiUrl) ? 'aimlapi' : 'custom';
  }
}

/** Usable when it has a key (or a local base URL that needs none). */
export function isAimlapiAvailable(settingsPath: string = paths.settings()): boolean {
  const config = resolveAimlapiConfig(settingsPath);
  return !config.requiresApiKey || config.apiKeys.length > 0;
}

export function isAimlapiSelected(settingsPath: string = paths.settings()): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'aimlapi';
}

import { getCredential } from '../../shared/EnvManager.js';
import { resolveMiniMaxChatCompletionsUrl } from '../../shared/minimax-base-url.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';

export type MiniMaxModel = 'MiniMax-M3' | 'MiniMax-M2.7';

export { DEFAULT_MINIMAX_API_URL, resolveMiniMaxChatCompletionsUrl } from '../../shared/minimax-base-url.js';

export function classifyMiniMaxError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;

  if (
    lower.includes('quota') ||
    lower.includes('insufficient') ||
    lower.includes('balance')
  ) {
    return new ClassifiedProviderError(
      `MiniMax quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'MiniMax rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `MiniMax auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `MiniMax bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `MiniMax upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  if (status === undefined) {
    return new ClassifiedProviderError(
      `MiniMax network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `MiniMax API error (status ${status})`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

interface MiniMaxResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: string | number; message?: string };
}

interface MiniMaxConfig {
  apiKey: string;
  model: MiniMaxModel;
  apiUrl: string;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;
const VALID_MODELS: MiniMaxModel[] = ['MiniMax-M3', 'MiniMax-M2.7'];

export class MiniMaxProvider extends OpenAICompatibleProvider<MiniMaxConfig> {
  protected readonly providerName = 'MiniMax';
  protected readonly syntheticIdPrefix = 'minimax';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): MiniMaxConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const apiKey = settings.CLAUDE_MEM_MINIMAX_API_KEY || getCredential('MINIMAX_API_KEY') || '';
    const configuredModel = settings.CLAUDE_MEM_MINIMAX_MODEL;
    const model = VALID_MODELS.includes(configuredModel as MiniMaxModel)
      ? configuredModel as MiniMaxModel
      : 'MiniMax-M3';
    const baseUrl = process.env.MINIMAX_BASE_URL || settings.CLAUDE_MEM_MINIMAX_BASE_URL;
    return { apiKey, model, apiUrl: resolveMiniMaxChatCompletionsUrl(baseUrl) };
  }

  protected missingApiKeyError(): Error {
    return new Error('MiniMax API key not configured. Set CLAUDE_MEM_MINIMAX_API_KEY in settings or MINIMAX_API_KEY environment variable.');
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return typeof result.inputTokens === 'number' && typeof result.outputTokens === 'number'
      ? { input: result.inputTokens, output: result.outputTokens }
      : null;
  }

  protected async query(history: ConversationMessage[], config: MiniMaxConfig): Promise<ProviderQueryResult> {
    const messages = history.map(message => ({
      role: message.role,
      content: message.content,
    }));

    logger.debug('SDK', `Querying MiniMax multi-turn (${config.model})`, {
      turns: messages.length,
      totalChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    });

    const data = await withRetry<MiniMaxResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await fetch(config.apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.3,
            max_tokens: 4096,
          }),
          signal: attemptSignal,
        });
      } catch (networkError: unknown) {
        throw classifyMiniMaxError({
          cause: networkError instanceof Error ? networkError : new Error(String(networkError)),
        });
      }

      if (!response.ok) {
        const bodyText = await response.text();
        throw classifyMiniMaxError({
          status: response.status,
          bodyText,
          headers: response.headers,
          cause: new Error(`MiniMax API error: ${response.status}`),
        });
      }

      const responseData = await response.json() as MiniMaxResponse;
      if (responseData.error) {
        throw classifyMiniMaxError({
          status: response.status,
          bodyText: `${responseData.error.code ?? ''} ${responseData.error.message ?? ''}`,
          headers: response.headers,
          cause: new Error(`MiniMax API error: ${responseData.error.code ?? ''}`),
        });
      }
      return responseData;
    }, { label: `MiniMax ${config.model}` });

    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      logger.error('SDK', 'Empty response from MiniMax');
      return { content: '' };
    }

    return {
      content,
      tokensUsed: data.usage?.total_tokens,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      servedModel: typeof data.model === 'string' && data.model ? data.model : undefined,
    };
  }
}

export function isMiniMaxAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return !!(settings.CLAUDE_MEM_MINIMAX_API_KEY || getCredential('MINIMAX_API_KEY'));
}

export function isMiniMaxSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'minimax';
}

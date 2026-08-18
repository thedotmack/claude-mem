// SPDX-License-Identifier: Apache-2.0

import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';

export const DEFAULT_OPENCODE_GO_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const CHAT_COMPLETIONS_PATH = '/chat/completions';

export function resolveOpenCodeChatCompletionsUrl(baseUrl: string | undefined | null): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_OPENCODE_GO_API_URL;
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }
  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}

export function classifyOpenCodeError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;

  let upstreamMessage = body.substring(0, 300);
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error?.message && typeof parsed.error.message === 'string') {
      upstreamMessage = parsed.error.message;
    }
  } catch {
    // Non-JSON body
  }

  const detail = { ...(input.requestId ? { requestId: input.requestId } : {}) };
  const describe = (cls: string): string =>
    `OpenCode ${cls}${status !== undefined ? ` (status ${status})` : ''}${upstreamMessage ? `: ${upstreamMessage}` : ''}`;

  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    lower.includes('key limit exceeded') ||
    (lower.includes('limit exceeded') && status !== 429) ||
    lower.includes('negative credit') ||
    status === 402
  ) {
    return new ClassifiedProviderError(
      describe('quota exhausted'),
      { kind: 'quota_exhausted', cause: input.cause, ...detail },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      describe('rate limit'),
      { kind: 'rate_limit', cause: input.cause, ...detail, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      describe('auth error'),
      { kind: 'auth_invalid', cause: input.cause, ...detail },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      describe('bad request'),
      { kind: 'unrecoverable', cause: input.cause, ...detail },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      describe('upstream error'),
      { kind: 'transient', cause: input.cause, ...detail },
    );
  }

  if (status === undefined) {
    return new ClassifiedProviderError(
      `OpenCode network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause, ...detail },
    );
  }

  return new ClassifiedProviderError(
    describe('API error'),
    { kind: 'unrecoverable', cause: input.cause, ...detail },
  );
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenCodeResponse {
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: string | number;
    message?: string;
  };
}

export interface OpenCodeConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
}

export class OpenCodeProvider extends OpenAICompatibleProvider<OpenCodeConfig> {
  protected readonly providerName = 'OpenCode';
  protected readonly syntheticIdPrefix = 'opencode';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OpenCodeConfig {
    return this.getOpenCodeConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('OpenCode API key not configured. Set CLAUDE_MEM_OPENCODE_API_KEY in settings or OPENCODE_API_KEY environment variable.');
  }

  protected prepareSessionExtras(session: ActiveSession, _config: OpenCodeConfig): void {
    session.endpointClass = 'custom';
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') {
      return null;
    }
    return {
      input: result.inputTokens,
      output: result.outputTokens,
      ...(typeof result.costUsd === 'number' ? { costUsd: result.costUsd } : {}),
    };
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  protected async query(history: ConversationMessage[], config: OpenCodeConfig): Promise<ProviderQueryResult> {
    return this.queryOpenCodeMultiTurn(history, config.apiKey, config.model, config.apiUrl);
  }

  private fetchChatCompletion(
    apiUrl: string,
    apiKey: string,
    model: string,
    messages: OpenAIMessage[],
    attemptSignal: AbortSignal
  ): Promise<Response> {
    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: attemptSignal,
    });
  }

  private async queryOpenCodeMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    apiUrl: string
  ): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(history.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenCode multi-turn (${model})`, {
      turns: history.length,
      totalChars,
      estimatedTokens,
      apiUrl,
    });

    const data = await withRetry<OpenCodeResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchChatCompletion(apiUrl, apiKey, model, messages, attemptSignal);
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyOpenCodeError({ cause: err });
      }

      const requestId = response.headers.get('x-request-id') ?? undefined;

      if (!response.ok) {
        const errorText = await response.text();
        throw classifyOpenCodeError({
          status: response.status,
          bodyText: errorText,
          headers: response.headers,
          cause: new Error(`OpenCode API error: ${response.status} - ${errorText}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      const responseData = await response.json() as OpenCodeResponse;

      if (responseData.error) {
        throw classifyOpenCodeError({
          status: response.status,
          bodyText: JSON.stringify(responseData),
          headers: response.headers,
          cause: new Error(`OpenCode API error: ${responseData.error.code} - ${responseData.error.message}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      return responseData;
    }, { label: `OpenCode ${model}` });

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OpenCode');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;
    const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;

    if (tokensUsed) {
      logger.info('SDK', 'OpenCode API usage', {
        model: servedModel ?? model,
        inputTokens: realInputTokens || 0,
        outputTokens: realOutputTokens || 0,
        totalTokens: tokensUsed,
        messagesInContext: history.length
      });
    }

    return { content, tokensUsed, inputTokens: realInputTokens, outputTokens: realOutputTokens, servedModel };
  }

  private getOpenCodeConfig(): OpenCodeConfig {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = (settings as Record<string, string>).CLAUDE_MEM_OPENCODE_API_KEY || getCredential('OPENCODE_API_KEY') || '';

    const rawModel: unknown = (settings as Record<string, string>).CLAUDE_MEM_OPENCODE_MODEL;
    const model = typeof rawModel === 'string' && rawModel.trim()
      ? rawModel
      : 'deepseek-v4-flash';

    const baseUrl = (settings as Record<string, string>).CLAUDE_MEM_OPENCODE_BASE_URL || process.env.OPENCODE_BASE_URL || '';
    const apiUrl = resolveOpenCodeChatCompletionsUrl(baseUrl);

    return { apiKey, model, apiUrl };
  }
}

export function isOpenCodeAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!((settings as Record<string, string>).CLAUDE_MEM_OPENCODE_API_KEY || getCredential('OPENCODE_API_KEY'));
}

export function isOpenCodeSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'opencode';
}

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef
} from './agents/index.js';

/**
 * Normalized result returned by a concrete provider's `query()`.
 * Optional fields (costUsd, servedModel) are populated only by providers that
 * surface them; absent fields are simply not forwarded.
 */
export interface ProviderQueryResult {
  content: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Real provider-reported spend in USD (only some gateways report it). */
  costUsd?: number;
  /** The model that actually served the request, when reported. */
  servedModel?: string;
}

/**
 * Shared scaffolding for OpenAI-compatible, multi-turn HTTP providers
 * (Gemini, OpenRouter). The session lifecycle — synthetic memory-session-id
 * generation, init/continuation prompt, the observation/summary message loop,
 * cumulative token accounting, abort-aware error handling, and history
 * truncation — is identical between them. Per-provider differences (config
 * resolution, request shape, token estimation, usage/cost reporting) are
 * supplied by abstract members.
 */
export abstract class OpenAICompatibleProvider<TConfig extends { apiKey: string; model: string }> {
  protected dbManager: DatabaseManager;
  protected sessionManager: SessionManager;

  /** Human-readable provider name passed to logging + processAgentResponse. */
  protected abstract readonly providerName: string;
  /** Prefix for the synthetic memorySessionId (e.g. 'gemini', 'openrouter'). */
  protected abstract readonly syntheticIdPrefix: string;
  /** Gemini guards its truncation loop with `truncated.length > 0`; OpenRouter does not. */
  protected abstract readonly requireNonEmptyToTruncate: boolean;
  /**
   * When a query returns empty content for an observation/summary message:
   * OpenRouter still calls processAgentResponse('') (forwards the empty batch
   * to the parser/recovery path); Gemini skips it and logs a warning. This flag
   * preserves that per-provider divergence.
   */
  protected abstract readonly forwardEmptyMessageResponse: boolean;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /** Resolve API key, model, and any per-provider request parameters. */
  protected abstract getConfig(): TConfig;

  /** Throw a provider-specific "API key not configured" error. */
  protected abstract missingApiKeyError(): Error;

  /** Issue the actual HTTP request and normalize its response. */
  protected abstract query(history: ConversationMessage[], config: TConfig): Promise<ProviderQueryResult>;

  /** Estimate token count for a single message body. */
  protected abstract estimateTokens(text: string): number;

  /** Build the session.lastUsage value from a query result. */
  protected abstract buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'];

  /** Hook for per-session setup that runs once config is resolved (e.g. endpointClass). */
  protected prepareSessionExtras(_session: ActiveSession, _config: TConfig): void {}

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getConfig();
    const { apiKey, model } = config;
    session.lastModelId = model;
    this.prepareSessionExtras(session, config);

    if (!apiKey) {
      throw this.missingApiKeyError();
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `${this.syntheticIdPrefix}-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      session.lastPromptSentAt = Date.now();
      session.lastGeneratorSource = 'init';
      const initResponse = await this.query(session.conversationHistory, config);
      await this.handleInitResponse(initResponse, session, worker, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${this.providerName} init query failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleSessionError(error, session, worker);
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.pendingAgentId = message.agentId ?? null;
        session.pendingAgentType = message.agentType ?? null;

        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          await this.processObservationMessage(session, message, worker, config, originalTimestamp, lastCwd);
        } else if (message.type === 'summarize') {
          await this.processSummaryMessage(session, message, worker, config, mode, originalTimestamp, lastCwd);
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', `${this.providerName} message loop failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${this.providerName} message loop failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleSessionError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', `${this.providerName} agent completed`, {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length
    });
  }

  private async handleInitResponse(
    initResponse: ProviderQueryResult,
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(initResponse);
      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, this.providerName, undefined, initResponse.servedModel ?? model
      );
    } else {
      logger.error('SDK', `Empty ${this.providerName} init response - session may lack context`, {
        sessionId: session.sessionDbId, model
      });
    }
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    worker: WorkerRef | undefined,
    config: TConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'ingest';
    const obsResponse = await this.query(session.conversationHistory, config);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      // Both sides or nothing: a backend reporting only one of the two counts
      // must not produce a half-real event (input=0 → compression_ratio 0.0).
      session.lastUsage = this.buildLastUsage(obsResponse);
    }

    if (obsResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        obsResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, obsResponse.servedModel ?? config.model
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} observation response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'summarize';
    const summaryResponse = await this.query(session.conversationHistory, config);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(summaryResponse);
    }

    if (summaryResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        summaryResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, summaryResponse.servedModel ?? config.model
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} summary response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  protected handleSessionError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', `${this.providerName} agent aborted`, { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', `${this.providerName} agent error`, { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  protected truncateHistory(history: ConversationMessage[], maxContextMessages: number, maxEstimatedTokens: number): ConversationMessage[] {
    if (history.length <= maxContextMessages) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= maxEstimatedTokens) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      const overLimit = truncated.length >= maxContextMessages || tokenCount + msgTokens > maxEstimatedTokens;
      if ((!this.requireNonEmptyToTruncate || truncated.length > 0) && overLimit) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxEstimatedTokens
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }
}

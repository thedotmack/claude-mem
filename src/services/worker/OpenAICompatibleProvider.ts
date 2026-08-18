import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import { resolveSummaryTierModel } from './model-aliases.js';
import { isClassified } from './provider-errors.js';
import { resolveContextWindowTokens, FALLBACK_CONTEXT_WINDOW_TOKENS } from './context-window.js';
import { buildCompactionTimeline } from './observer-compaction.js';
import {
  processAgentResponse,
  snapshotResponseContext,
  isAbortError,
  type WorkerRef
} from './agents/index.js';

const COMPACT_TRIGGER_RATIO = 0.7;
const REINJECT_BUDGET_RATIO = 0.3;
const PAYLOAD_WINDOW_RATIO = 0.25;
const PROMPT_WINDOW_RATIO = 0.5;
const PAYLOAD_CHARS_PER_TOKEN = 4;
const PAYLOAD_MIN_CHARS = 256;

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
 * cumulative token accounting, abort-aware error handling, and context
 * compaction — is identical between them. Per-provider differences (config
 * resolution, request shape, token estimation, usage/cost reporting) are
 * supplied by abstract members. User prompts are pushed here; accepted
 * assistant responses are pushed by processAgentResponse.
 */
export abstract class OpenAICompatibleProvider<TConfig extends { apiKey: string; model: string }> {
  protected dbManager: DatabaseManager;
  protected sessionManager: SessionManager;

  /** Human-readable provider name passed to logging + processAgentResponse. */
  protected abstract readonly providerName: string;
  /** Prefix for the synthetic memorySessionId (e.g. 'gemini', 'openrouter'). */
  protected abstract readonly syntheticIdPrefix: string;
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

    const startupSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const contextWindowTokens = startupSettings.CLAUDE_MEM_OBSERVER_COMPACTION_ENABLED === 'false'
      ? FALLBACK_CONTEXT_WINDOW_TOKENS
      : await resolveContextWindowTokens(this.syntheticIdPrefix, config.model, session.endpointClass);

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
    const initContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      session.lastPromptSentAt = Date.now();
      session.lastGeneratorSource = 'init';
      const initResponse = await this.query(session.conversationHistory, config);
      await this.handleInitResponse(initResponse, session, worker, model, initContext);
    } catch (error: unknown) {
      // Classified errors are logged once, at SessionRoutes' `Observer failed`
      // line; here they're debug-level so one failure isn't five error lines.
      if (isClassified(error)) {
        logger.debug('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model, kind: error.kind }, error);
      } else if (error instanceof Error) {
        logger.error('SDK', `${this.providerName} init query failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${this.providerName} init query failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleSessionError(error, session, worker);
    }

    try {
      await this.runMessageLoop(session, worker, config, mode, contextWindowTokens);
    } catch (error: unknown) {
      if (isClassified(error)) {
        logger.debug('SDK', `${this.providerName} message loop failed`, { sessionId: session.sessionDbId, model, kind: error.kind }, error);
      } else if (error instanceof Error) {
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

  private async runMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig,
    contextWindowTokens: number
  ): Promise<void> {
    let lastCwd: string | undefined;

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        lastCwd = message.cwd;
      }
      const originalTimestamp = session.earliestPendingTimestamp;

      const pendingPrompt = this.buildPendingPrompt(
        session,
        message,
        mode,
        contextWindowTokens,
        originalTimestamp
      );
      this.maybeCompactHistory(
        session,
        mode,
        contextWindowTokens,
        lastCwd,
        pendingPrompt === null ? 0 : this.estimateTokens(pendingPrompt)
      );

      if (message.type === 'observation') {
        await this.processObservationMessage(
          session,
          message,
          worker,
          config,
          originalTimestamp,
          lastCwd,
          pendingPrompt!
        );
      } else if (message.type === 'summarize') {
        await this.processSummaryMessage(
          session,
          worker,
          config,
          originalTimestamp,
          lastCwd,
          pendingPrompt!
        );
      }
    }
  }

  private async handleInitResponse(
    initResponse: ProviderQueryResult,
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string,
    responseContext: ReturnType<typeof snapshotResponseContext>
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      this.accumulateUsage(session, initResponse);
      session.lastUsage = this.buildLastUsage(initResponse);
      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, this.providerName, undefined, initResponse.servedModel ?? model, responseContext
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
    lastCwd: string | undefined,
    obsPrompt: string
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const responseContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'ingest';
    const obsResponse = await this.query(session.conversationHistory, config);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      this.accumulateUsage(session, obsResponse);
      // Both sides or nothing: a backend reporting only one of the two counts
      // must not produce a half-real event (input=0 → compression_ratio 0.0).
      session.lastUsage = this.buildLastUsage(obsResponse);
    }

    if (obsResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        obsResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, obsResponse.servedModel ?? config.model, responseContext
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} observation response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    config: TConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    summaryPrompt: string
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const responseContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'summarize';
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const summaryModel = resolveSummaryTierModel(config.model, settings);
    const summaryConfig = summaryModel === config.model ? config : { ...config, model: summaryModel };
    if (summaryConfig !== config) {
      logger.debug('SESSION', 'Tier routing: summary model', {
        sessionId: session.sessionDbId, model: summaryModel
      });
    }
    const summaryResponse = await this.query(session.conversationHistory, summaryConfig);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      this.accumulateUsage(session, summaryResponse);
      session.lastUsage = this.buildLastUsage(summaryResponse);
    }

    if (summaryResponse.content || this.forwardEmptyMessageResponse) {
      await processAgentResponse(
        summaryResponse.content || '', session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, this.providerName, lastCwd, summaryResponse.servedModel ?? summaryConfig.model, responseContext
      );
    } else {
      logger.warn('SDK', `Empty ${this.providerName} summary response, leaving queue intact`, {
        sessionId: session.sessionDbId
      });
    }
  }

  private boundText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)} …[truncated ${text.length - maxChars} chars]`;
  }

  private boundPayloadJson(value: unknown, maxChars: number): string {
    return this.boundText(JSON.stringify(value) ?? String(value), maxChars);
  }

  /**
   * Build the exact prompt that will be dispatched. Measuring the rendered
   * prompt, rather than only its raw payload, accounts for JSON escaping and
   * template scaffolding before the context-budget decision is made.
   */
  private buildPendingPrompt(
    session: ActiveSession,
    message: {
      type?: string;
      tool_name?: string;
      tool_input?: unknown;
      tool_response?: unknown;
      cwd?: string;
      last_assistant_message?: string;
    },
    mode: ModeConfig,
    contextWindowTokens: number,
    originalTimestamp: number | null
  ): string | null {
    if (message.type !== 'observation' && message.type !== 'summarize') {
      return null;
    }

    const promptCapTokens = contextWindowTokens * PROMPT_WINDOW_RATIO;
    let maxChars = Math.floor(contextWindowTokens * PAYLOAD_WINDOW_RATIO) * PAYLOAD_CHARS_PER_TOKEN;

    for (;;) {
      const prompt = message.type === 'observation'
        ? buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: this.boundPayloadJson(message.tool_input, maxChars),
            tool_output: this.boundPayloadJson(message.tool_response, maxChars),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          })
        : buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId ?? '',
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: this.boundText(message.last_assistant_message || '', maxChars)
          }, mode);

      if (this.estimateTokens(prompt) <= promptCapTokens || maxChars <= PAYLOAD_MIN_CHARS) {
        return prompt;
      }
      maxChars = Math.floor(maxChars / 2);
    }
  }

  /**
   * Replace oversized provider history with a bounded continuation context.
   * The replacement is built first and assigned atomically. If timeline
   * construction fails, the original history is preserved and the provider
   * can still process the turn using its existing context.
   */
  private maybeCompactHistory(
    session: ActiveSession,
    mode: ModeConfig,
    contextWindowTokens: number,
    lastCwd: string | undefined,
    pendingMessageTokens = 0
  ): void {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_OBSERVER_COMPACTION_ENABLED === 'false') {
      return;
    }

    const estimatedHistoryTokens = this.estimateTokens(
      session.conversationHistory.map(message => message.content).join('')
    );
    if (estimatedHistoryTokens + pendingMessageTokens <= contextWindowTokens * COMPACT_TRIGGER_RATIO) {
      return;
    }

    const continuationPrompt = buildContinuationPrompt(
      session.userPrompt,
      session.lastPromptNumber,
      session.contentSessionId,
      mode
    );
    const tokenBudget = Math.max(
      0,
      Math.floor(contextWindowTokens * REINJECT_BUDGET_RATIO)
        - this.estimateTokens(continuationPrompt)
        - pendingMessageTokens
    );

    let timeline: string;
    try {
      timeline = buildCompactionTimeline(
        this.dbManager.getSessionStore(),
        session.project,
        lastCwd ?? session.project,
        tokenBudget
      );
    } catch (error: unknown) {
      logger.warn('SDK', 'Observer history compaction failed; preserving existing history', {
        sessionId: session.sessionDbId,
        beforeMessages: session.conversationHistory.length,
        beforeTokens: estimatedHistoryTokens,
        contextWindowTokens,
        rawError: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const content = timeline
      ? `${continuationPrompt}\n\n<recent_project_timeline>\n${timeline}\n</recent_project_timeline>`
      : continuationPrompt;
    const beforeMessages = session.conversationHistory.length;
    session.conversationHistory.splice(
      0,
      session.conversationHistory.length,
      { role: 'user', content }
    );

    const afterTokens = this.estimateTokens(content);
    logger.info('SDK', 'Observer history compacted', {
      sessionId: session.sessionDbId,
      beforeMessages,
      beforeTokens: estimatedHistoryTokens,
      afterTokens,
      contextWindowTokens
    });
    if (afterTokens > contextWindowTokens * COMPACT_TRIGGER_RATIO) {
      logger.warn('SDK', 'Compacted context alone exceeds the compaction trigger — context window too small; the next message will re-compact', {
        sessionId: session.sessionDbId,
        afterTokens,
        contextWindowTokens
      });
    }
  }

  private accumulateUsage(session: ActiveSession, result: ProviderQueryResult): void {
    if (typeof result.inputTokens === 'number' && typeof result.outputTokens === 'number') {
      session.cumulativeInputTokens += result.inputTokens;
      session.cumulativeOutputTokens += result.outputTokens;
      return;
    }

    const tokensUsed = result.tokensUsed || 0;
    session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
    session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
  }

  protected handleSessionError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', `${this.providerName} agent aborted`, { sessionId: session.sessionDbId });
      throw error;
    }

    if (isClassified(error)) {
      // Logged once at SessionRoutes' `Observer failed` line.
      logger.debug('SDK', `${this.providerName} agent error`, { sessionDbId: session.sessionDbId, kind: error.kind }, error);
    } else {
      logger.failure('SDK', `${this.providerName} agent error`, { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    }
    throw error;
  }

}

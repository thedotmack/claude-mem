import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  buildInitPrompt,
  buildObservationPromptParts,
  renderObservationPrompt,
  type ObservationPromptParts,
  buildSummaryPrompt,
  buildContinuationPrompt,
  splitFramingPrompt,
} from '../../sdk/prompts.js';
import { pruneProcessedObservationPayloads } from './history-pruning.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import { resolveSummaryTierModel } from './model-aliases.js';
import { accumulateObserverUsage, observerUsageLogFields } from './observer-usage.js';
import { DEADLINE_EXCEEDED_CODE, PAID_SEND_BUDGET_EXHAUSTED_CODE, isClassified, paidSendOutcomeOf, type ClassifiedProviderError } from './provider-errors.js';
import { paidSendBudgetForClaimedBatch, type PaidSendBudget } from './paid-send-budget.js';
import {
  shouldRecycleConversation,
  describeGenerationUsage,
  resolveConversationMaxChars,
  windowAwareConversationMaxChars,
} from '../../shared/observer-recycle.js';
import { resolveContextWindowTokens, observationFieldMaxChars, resolveObserverMaxOutputTokens } from './context-window.js';
import { recycleObserverConversation, loadSessionStartContext, openObserverGeneration, observesBarePrompts } from './session/recycle-conversation.js';
import { optimizeObservationFields, buildFieldCompressionPrompt, type CompressedField } from './field-optimizer.js';
import { resolveFieldOptimizeTimeoutMs } from './retry.js';
import { buildTelegramWrapupPrompt, type TelegramWrapupFormatterInput } from '../integrations/TelegramWrapupNotifier.js';

import {
  processAgentResponse,
  snapshotResponseContext,
  takeObserverSchemaReminder,
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
  /**
   * Why generation stopped, as the provider reported it: OpenRouter's
   * finish_reason ('stop', 'length', …) or Gemini's finishReason ('STOP',
   * 'MAX_TOKENS', …). 'length' / 'MAX_TOKENS' mean the output-token cap cut
   * the reply off (#3868).
   */
  finishReason?: string;
}

/** The first user turn of an observer request when the framing prompt carries no request block. */
const OBSERVER_KICKOFF = 'Start observing the primary session.';

/** One message of an OpenAI-shaped `/chat/completions` request. */
export interface OpenAIChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Sent when every turn is empty, so a request never carries `messages: []`. */
const EMPTY_HISTORY_FALLBACK = '(context unavailable)';

/**
 * The answer text of an OpenAI-shaped reply's `message.content`. Gateways may
 * send content blocks instead of a string; only text blocks count, and
 * reasoning or tool-call arguments are never substituted for the answer
 * (#4017). Anything else reads as no text.
 */
export function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
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
export abstract class OpenAICompatibleProvider<TConfig extends { apiKey: string; model: string; plainText?: boolean }> {
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

  /**
   * Whether an empty API key is a misconfiguration for this provider.
   *
   * True for every hosted endpoint, and the default so Gemini and OpenRouter
   * keep failing fast exactly as before. A local OpenAI-compatible server
   * (Ollama, LM Studio, an unauthenticated vLLM) accepts any bearer token or
   * none, so for those an empty key is the correct configuration and must not
   * be treated as an unconfigured provider.
   */
  protected requiresApiKey(_config: TConfig): boolean {
    return true;
  }

  /**
   * Issue the actual HTTP request and normalize its response.
   * `perAttemptTimeoutMs` overrides the CLAUDE_MEM_LLM_TIMEOUT_MS per-attempt
   * deadline for callers racing their own, longer deadline (the field pass).
   * `paidSendBudget` is the claimed batch's allowance (absent for an init
   * turn, a field condensation or a wrap-up, which are not batches); its
   * clientAttemptId goes out as `x-client-request-id`.
   */
  protected abstract query(
    history: ConversationMessage[],
    config: TConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    paidSendBudget?: PaidSendBudget,
  ): Promise<ProviderQueryResult>;

  /**
   * One bounded, standalone call that condenses an oversized tool payload.
   *
   * Issued off to the side with its own single-message history: adding it to
   * `session.conversationHistory` would grow the very conversation the recycle
   * logic exists to bound.
   */
  private async compressField(
    text: string,
    budgetChars: number,
    config: TConfig,
    signal: AbortSignal,
    deadlineMs?: number,
  ): Promise<CompressedField | null> {
    // The field pass races `deadlineMs` (CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS).
    // Without it the request keeps the LLM per-attempt default, and a longer
    // field knob would never take effect on this path (#4134).
    const result = await this.query(
      [{ role: 'user', content: buildFieldCompressionPrompt(text, budgetChars) }],
      config,
      signal,
      deadlineMs,
    );
    if (!result.content) return null;
    return { text: result.content, truncated: result.finishReason === 'length' || result.finishReason === 'MAX_TOKENS' };
  }

  /**
   * The output-token cap a field-compression request is sent with, so the
   * condense prompt never asks for more than it can carry. The HTTP providers
   * send CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS on every request; one that sends
   * no cap returns undefined and keeps the field-cap budget.
   */
  protected fieldCompressionMaxOutputTokens(): number | undefined {
    return resolveObserverMaxOutputTokens();
  }

  /** Format a stored summary through this provider's normal summary-model query path. */
  async formatTelegramWrapup(
    input: TelegramWrapupFormatterInput,
    activeModelId?: string,
  ): Promise<string> {
    const config = this.getConfig();
    if (!config.apiKey && this.requiresApiKey(config)) {
      throw this.missingApiKeyError();
    }
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const model = resolveSummaryTierModel(activeModelId ?? config.model, settings);
    const summaryConfig = { ...config, model, plainText: true };
    const result = await this.query(
      [{ role: 'user', content: buildTelegramWrapupPrompt(input.summaryText) }],
      summaryConfig,
    );
    if (!result.content?.trim()) {
      const error = new Error(`${this.providerName} returned no text for the Telegram wrap-up`);
      logger.error('TELEGRAM', error.message, { sessionId: input.sessionDbId, model }, error);
      throw error;
    }
    return result.content;
  }

  /** Estimate token count for a single message body. */
  protected abstract estimateTokens(text: string): number;

  /** Build the session.lastUsage value from a query result. */
  protected abstract buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'];

  /** Hook for per-session setup that runs once config is resolved (e.g. endpointClass). */
  protected prepareSessionExtras(_session: ActiveSession, _config: TConfig): void {}

  /**
   * The system anchor for a request, and the turns sent after it (#3868).
   *
   * A generation's framing prompt carries the observer's instructions and the
   * output schema. Sent as a user turn, a small model loses the schema as the
   * conversation grows, and the batch comes back schema-less. Its instructions
   * go out as the system message instead, and its user-request block (or a
   * fixed kickoff) stays the first user turn, so every request, the init one
   * included, carries at least one user message. A history with no framing
   * prompt (a standalone field condensation or wrap-up request) is sent as is.
   */
  protected anchorFraming(history: ConversationMessage[]): { system: string | null; turns: ConversationMessage[] } {
    const first = history[0];
    if (!first?.framing) {
      return { system: null, turns: history };
    }
    const { instructions, userRequest } = splitFramingPrompt(first.content);
    return {
      system: instructions,
      turns: [{ role: 'user', content: userRequest ?? OBSERVER_KICKOFF }, ...history.slice(1)],
    };
  }

  /**
   * The chat messages for an OpenAI-shaped request. An observer generation's
   * framing prompt goes out as the system message and its user request as the
   * first user turn (anchorFraming). After it, empty turns are dropped,
   * consecutive same-role turns are merged and a leading assistant turn is
   * skipped (#3491): the strict chat templates behind vLLM, Ollama and LM
   * Studio reject all three, and an empty init reply or an empty observation
   * reply produces them. A request never carries an empty message list.
   */
  protected conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIChatMessage[] {
    const { system, turns } = this.anchorFraming(history);
    const anchor: OpenAIChatMessage[] = system ? [{ role: 'system', content: system }] : [];

    let newestNonEmptyContent: string | null = null;
    for (const msg of turns) {
      const trimmed = msg.content.trim();
      if (trimmed.length > 0) {
        newestNonEmptyContent = trimmed;
      }
    }

    const messages: OpenAIChatMessage[] = [];
    for (const msg of turns) {
      const trimmed = msg.content.trim();
      if (!trimmed) {
        continue;
      }

      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      if (messages.length === 0 && role === 'assistant') {
        continue;
      }

      const previous = messages[messages.length - 1];
      if (previous?.role === role) {
        previous.content = `${previous.content}\n\n${msg.content}`;
      } else {
        messages.push({ role, content: msg.content });
      }
    }

    if (messages.length === 0) {
      return [...anchor, {
        role: 'user',
        content: newestNonEmptyContent ?? EMPTY_HISTORY_FALLBACK,
      }];
    }

    return [...anchor, ...messages];
  }

  /**
   * The observer model's context window in tokens (#3625). This default knows
   * only the CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW override and the fallback;
   * providers with a model map or catalogue override it.
   */
  protected resolveContextWindow(config: TConfig): Promise<number> {
    return resolveContextWindowTokens('openrouter', config.model);
  }

  /**
   * Character budget for one observer generation: operator-overridable (#3800)
   * and never more than half this generation's model window (#3625).
   */
  protected conversationMaxChars(session: ActiveSession): number {
    return windowAwareConversationMaxChars(
      resolveConversationMaxChars(
        SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS
      ),
      session.observerContextWindowTokens,
    );
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getConfig();
    const { apiKey, model } = config;
    session.lastModelId = model;
    this.prepareSessionExtras(session, config);

    if (!apiKey && this.requiresApiKey(config)) {
      throw this.missingApiKeyError();
    }

    if (!session.memorySessionId) {
      const persistedMemorySessionId = this.dbManager.getSessionById(session.sessionDbId).memory_session_id;
      const syntheticIdPrefix = `${this.syntheticIdPrefix}-${session.contentSessionId}-`;

      if (persistedMemorySessionId?.startsWith(syntheticIdPrefix)) {
        session.memorySessionId = persistedMemorySessionId;
        logger.info('SESSION', `MEMORY_ID_REUSED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
      } else {
        const syntheticMemorySessionId = `${syntheticIdPrefix}${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${this.providerName}`);
      }
    }

    // Resolved once per generation: the generation budget and the per-field
    // cap both scale with the model's window (#3625).
    session.observerContextWindowTokens = await this.resolveContextWindow(config);

    const mode = ModeManager.getInstance().getActiveMode();
    // Seed the generation with what this session already observed, so a
    // conversation that starts partway through (a recycle, or a resume after a
    // quota pause) continues from the memory rather than from nothing (#3800).
    const priorContext = await loadSessionStartContext(session);
    // Prompt 0 means no user_prompts row exists for this session (a
    // transcript-ingested turn with no anchor). Treat it, like the genuine
    // first prompt, as an init rather than an empty continuation the model
    // rejects as prose (#3653).
    const initPrompt = session.lastPromptNumber <= 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode, priorContext)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode, priorContext);

    // Every request re-sends the history, so a restart must not carry the
    // previous attempt's turns into the new generation.
    openObserverGeneration(session, initPrompt);

    // By default the init prompt is not a request of its own: it stays the
    // generation's opening user turn, and the first observation or summary
    // request carries it (consecutive user turns merge on the wire).
    if (observesBarePrompts()) {
      try {
        session.lastPromptSentAt = Date.now();
        session.lastGeneratorSource = 'init';
        const initResponse = await this.queryObserverTurn(session, config, undefined);
        this.handleInitResponse(initResponse, session, model);
      } catch (error: unknown) {
        if (await this.recycleOnContextOverflow(error, session, worker)) return;
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
    }

    try {
      await this.runMessageLoop(session, worker, config, mode);
    } catch (error: unknown) {
      if (await this.recycleOnContextOverflow(error, session, worker)) return;
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
      historyLength: session.conversationHistory.length,
      ...observerUsageLogFields(session)
    });
  }

  private async runMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    config: TConfig,
    mode: ModeConfig
  ): Promise<void> {
    let lastCwd: string | undefined;

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
  }

  private handleInitResponse(
    initResponse: ProviderQueryResult,
    session: ActiveSession,
    model: string
  ): void {
    // The init turn is billed whether or not its reply carried any text.
    accumulateObserverUsage(session, initResponse);

    if (!initResponse.content && !this.forwardEmptyMessageResponse) {
      logger.error('SDK', `Empty ${this.providerName} init response - session may lack context`, {
        sessionId: session.sessionDbId, model
      });
      return;
    }

    // The init prompt carries the user's request and no tool call, so nothing in
    // its reply can be an observation of this session — an <observation> here was
    // invented from <user_request> alone and would be stored as memory for work
    // that never happened. Keep the turn so role alternation holds, but never
    // hand it to the storage path.
    session.conversationHistory.push({ role: 'assistant', content: initResponse.content || '' });
  }

  /**
   * A provider that extends an observation turn with more queued work (Codex
   * batching) must not send, or keep processing, after the session aborted:
   * its extra claims would otherwise ride on a turn nobody waits for.
   */
  protected readonly rejectAbortedObservation: boolean = false;

  /** Providers may extend an observation request with immediately available work. */
  protected observationTurnPrompt(_session: ActiveSession, _message: PendingMessageWithId, prompt: ObservationPromptParts): string {
    return renderObservationPrompt(prompt);
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: PendingMessageWithId,
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

    // Retire a full generation BEFORE sending, so the request that would cross
    // the ceiling is never paid for. The batch is preserved and drained by the
    // fresh generation the next ingest starts (#3800).
    if (shouldRecycleConversation(session.conversationHistory, this.conversationMaxChars(session), session.lastContextTokens)) {
      await recycleObserverConversation(
        session,
        this.sessionManager,
        worker,
        'budget',
        describeGenerationUsage(session.conversationHistory, session.lastContextTokens),
      );
      return;
    }

    // An oversized payload is condensed by a bounded model pass before the
    // prompt is built, so the observation carries a summary of the whole field
    // rather than a head/tail slice with the middle cut out (#3800). The field
    // cap scales with the model's window (#3625).
    const fieldMaxChars = observationFieldMaxChars(session.observerContextWindowTokens);
    const optimized = await optimizeObservationFields(
      { toolInput: message.tool_input, toolOutput: message.tool_response },
      (text, budgetChars, signal, deadlineMs) => this.compressField(text, budgetChars, config, signal, deadlineMs),
      { sessionDbId: session.sessionDbId, toolName: message.tool_name },
      fieldMaxChars,
      resolveFieldOptimizeTimeoutMs,
      session.observerContextWindowTokens,
      () => this.fieldCompressionMaxOutputTokens(),
    );

    const obsPrompt = buildObservationPromptParts({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(optimized.toolInput),
      tool_output: JSON.stringify(optimized.toolOutput),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    }, fieldMaxChars, takeObserverSchemaReminder(session));
    const responseContext = snapshotResponseContext(session);

    const turnPrompt = this.observationTurnPrompt(session, message, obsPrompt);
    if (this.rejectAbortedObservation) session.abortController.signal.throwIfAborted();
    session.conversationHistory.push({ role: 'user', content: turnPrompt });

    // Stub out payloads already converted to stored observations so the
    // request below stays bounded instead of re-sending every prior tool
    // dump (see history-pruning.ts).
    pruneProcessedObservationPayloads(session.conversationHistory);

    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'ingest';
    const obsResponse = await this.queryObserverTurn(session, config, paidSendBudgetForClaimedBatch(session));

    // Billed usage counts even when the reply came back empty.
    accumulateObserverUsage(session, obsResponse);
    this.recordMeasuredContext(session, obsResponse);
    // Both sides or nothing: a backend reporting only one of the two counts
    // must not produce a half-real event (input=0 → compression_ratio 0.0).
    session.lastUsage = this.buildLastUsage(obsResponse);
    const tokensUsed = obsResponse.tokensUsed || 0;
    // Billed above either way; an aborted session's reply is not stored.
    if (this.rejectAbortedObservation) session.abortController.signal.throwIfAborted();

    // The assistant turn is appended once, by processAgentResponse below.
    // Appending it here too stored every reply twice (#3619), inflating the
    // window — and therefore every subsequent request — by ~50%.
    if (obsResponse.content || this.forwardEmptyMessageResponse) {
      // Scoped to this reply: processAgentResponse consumes and clears it.
      session.lastFinishReason = obsResponse.finishReason ?? null;
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
    const responseContext = snapshotResponseContext(session);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });

    // Same bounding as the observation path: the summary reads the assistant
    // observations for its narrative, not the raw tool payloads behind them.
    pruneProcessedObservationPayloads(session.conversationHistory);

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
    const summaryResponse = await this.queryObserverTurn(session, summaryConfig, paidSendBudgetForClaimedBatch(session));

    accumulateObserverUsage(session, summaryResponse);
    this.recordMeasuredContext(session, summaryResponse);
    session.lastUsage = this.buildLastUsage(summaryResponse);
    const tokensUsed = summaryResponse.tokensUsed || 0;

    // Appended once, by processAgentResponse below — see processObservationMessage.
    if (summaryResponse.content || this.forwardEmptyMessageResponse) {
      session.lastFinishReason = summaryResponse.finishReason ?? null;
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

  /**
   * Send one observer turn (init, observation or summary) on the session's
   * conversation. An output failure (the backend answered and billed it, but
   * the body was unreadable, a 200 carried litellm's "Unable to get json", or
   * Codex completed without usable output) is never resent and never ends the
   * session: it is passed on as an empty reply, so the empty-reply handling
   * settles this batch alone and the work buffered behind it keeps flowing.
   * withRetry has already charged it to the batch's PaidSendBudget.
   */
  private async queryObserverTurn(
    session: ActiveSession,
    config: TConfig,
    paidSendBudget: PaidSendBudget | undefined,
  ): Promise<ProviderQueryResult> {
    try {
      return await this.query(session.conversationHistory, config, undefined, undefined, paidSendBudget);
    } catch (error: unknown) {
      if (!isClassified(error) || paidSendOutcomeOf(error) !== 'output_failure') throw error;
      logger.warn('SDK', `${this.providerName} answered with unusable output; passing an empty reply on, not resending`, {
        sessionId: session.sessionDbId,
        claimedMessageIds: [...session.claimedMessageIds],
        code: error.code,
        message: error.message,
        clientAttemptId: error.clientAttemptId ?? paidSendBudget?.clientAttemptId,
        paidSendsSpent: paidSendBudget?.spentPaidSends,
      });
      return { content: '' };
    }
  }

  /**
   * The prompt tokens a request actually read feed the generation budget
   * (#2957). Called for observation and summary replies only: an init reading
   * is never kept, so an init prompt larger than the budget cannot recycle
   * every fresh generation on it.
   */
  private recordMeasuredContext(session: ActiveSession, result: ProviderQueryResult): void {
    if (typeof result.inputTokens === 'number' && result.inputTokens > 0) {
      session.lastContextTokens = result.inputTokens;
    }
  }

  /**
   * The reactive net under the generation budget (#3625): a provider that
   * refuses the request as too long for the model's window retires the
   * conversation the way Claude's text-form "Prompt is too long" does. The
   * batch goes back to pending and a fresh generation resumes it. Returns
   * false for every other failure. Before this, an HTTP context-length 400 was
   * an unrecoverable error that finalized the session and dropped the buffer.
   */
  private async recycleOnContextOverflow(
    error: unknown,
    session: ActiveSession,
    worker: WorkerRef | undefined,
  ): Promise<boolean> {
    if (!isClassified(error) || error.kind !== 'context_overflow') return false;
    await recycleObserverConversation(
      session,
      this.sessionManager,
      worker,
      'refused',
      `${this.providerName} refused the request as too long: ${error.message}`,
    );
    return true;
  }

  /**
   * Map a classified provider failure onto the abortReason category that keeps
   * buffered work alive.
   *
   * handleGeneratorExit finalizes the session — dropping whatever is buffered —
   * for every category outside its preserve list. Quota was only ever set by
   * the two PROACTIVE sites (the pre-request rate-limit guard and the
   * observer-text heuristic), so a real 429 coming back from the provider left
   * abortReason null and the session was torn down as if the failure were
   * fatal (#3700). These conditions clear on their own; the work should still
   * be there when they do.
   */
  private preservingAbortReason(error: ClassifiedProviderError): string | null {
    switch (error.kind) {
      case 'quota_exhausted':
        return `quota:${error.kind}`;
      // Its own category: a rate limit clears on its own and is not a spent
      // allowance, so telemetry and the exit path must not count it as one.
      case 'rate_limit':
        return `rate_limit:${error.kind}`;
      // Same shape, same list: handleGeneratorExit already honours 'auth', and
      // credentials that are fixed by /login are no more fatal than a 429.
      case 'auth_invalid':
        return `auth:${error.kind}`;
      // A timeout or network fault that outlived the retry policy. Finalizing
      // would turn it into permanent data loss — the same reasoning as the
      // observer-text transport path in ResponseProcessor (#3752). Our own
      // per-attempt deadline keeps its own reason, so an abandoned request
      // stays countable apart from a network fault.
      // A batch whose paid-send budget is spent pauses the same way; the
      // transport resume parks it instead of resending (SessionManager).
      case 'transient':
        return error.code === DEADLINE_EXCEEDED_CODE || error.code === PAID_SEND_BUDGET_EXHAUSTED_CODE
          ? `transport:${error.code}`
          : `transport:${error.kind}`;
      default:
        return null;
    }
  }

  protected handleSessionError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', `${this.providerName} agent aborted`, {
        sessionId: session.sessionDbId,
        ...observerUsageLogFields(session)
      });
      throw error;
    }

    if (isClassified(error)) {
      // Set BEFORE the rethrow: the .finally() in SessionRoutes reads
      // session.abortReason to decide whether to finalize the session, so a
      // reason recorded after unwinding would arrive too late to matter.
      const preserving = this.preservingAbortReason(error);
      if (preserving !== null) {
        session.abortReason = preserving;
        // Abort as well as label. Without it the controller stays live while
        // the error unwinds, and the session route books the failure twice —
        // an observer failure and an error outcome on the way out, then the
        // aborted outcome at finalization — leaving observer-health marked
        // failed for a pause that is not a failure. This is what the two
        // observer-text paths already do for the same conditions.
        try {
          session.abortController.abort();
        } catch {
          // best-effort; AbortController.abort() should not throw in normal use.
        }
        logger.warn('SDK', `${this.providerName} paused on ${error.kind}; preserving buffered work`, {
          sessionId: session.sessionDbId,
          kind: error.kind,
          ...(error.code ? { code: error.code } : {}),
          ...observerUsageLogFields(session)
        });
      }

      // Logged once at SessionRoutes' `Observer failed` line.
      logger.debug('SDK', `${this.providerName} agent error`, {
        sessionDbId: session.sessionDbId,
        kind: error.kind,
        ...observerUsageLogFields(session)
      }, error);
    } else {
      logger.failure('SDK', `${this.providerName} agent error`, {
        sessionDbId: session.sessionDbId,
        ...observerUsageLogFields(session)
      }, error instanceof Error ? error : new Error(String(error)));
    }
    throw error;
  }

}

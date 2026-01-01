/**
 * OpenAICompatibleAgent: OpenAI Chat Completions-compatible observation extraction
 *
 * Implements the same behavior as OpenRouterAgent (non-streaming REST, no tool_calls),
 * but allows configuring arbitrary Chat Completions-compatible endpoints via profiles.
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { updateCursorContextForProject } from '../worker-service.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

// Context window management constants (defaults; behavior can be tuned via profile.maxContextTokens)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Budgeting for Chat Completions requests (prompt + completion must fit within model context)
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MIN_OUTPUT_TOKENS = 256;
const DEFAULT_OUTPUT_TOKEN_RATIO = 0.25;
const SAFETY_BUFFER_TOKENS = 512;
const MIN_PROMPT_BUDGET_TOKENS = 512;

// Rolling summary (context compression) settings
const KEEP_RECENT_MESSAGES_FOR_SUMMARY = 6;
const INTERNAL_SUMMARY_MAX_OUTPUT_TOKENS = 512;
const MAX_CONTEXT_COMPRESSION_PASSES = 3;

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAICompatibleResponse {
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
    message?: string;
    code?: string;
  };
}

export interface OpenAICompatibleProfile {
  id: string;
  baseUrl: string;
  chatCompletionsPath: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  maxContextTokens?: number;
}

// Forward declaration for fallback agent type
type FallbackAgent = {
  startSession(session: ActiveSession, worker?: any): Promise<void>;
};

function safeParseProfiles(json: string): OpenAICompatibleProfile[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed as OpenAICompatibleProfile[];
  } catch {
    return [];
  }
}

function pickActiveProfile(
  profiles: OpenAICompatibleProfile[],
  activeId: string
): OpenAICompatibleProfile | null {
  if (profiles.length === 0) return null;
  const selected = profiles.find(p => p && p.id === activeId);
  return selected || profiles[0] || null;
}

export class OpenAICompatibleAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when the provider API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Check if an error should trigger fallback to Claude
   */
  private shouldFallbackToClaude(error: any): boolean {
    const message = error?.message || '';
    // Fall back on rate limit (429), server errors (5xx), or network issues
    return (
      message.includes('429') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('fetch failed')
    );
  }

  /**
   * Start OpenAI-compatible agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: any): Promise<void> {
    try {
      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Get provider configuration
      const { apiKey, model, requestUrl, headers, maxContextTokens } = this.getOpenAICompatibleConfig();

      if (!requestUrl) {
        throw new Error('OpenAI Compatible provider is not configured. Set CLAUDE_MEM_OPENAI_COMPATIBLE_PROFILES and CLAUDE_MEM_OPENAI_COMPATIBLE_ACTIVE_PROFILE in settings.');
      }

      if (!apiKey) {
        throw new Error('OpenAI Compatible API key not configured. Set apiKey in the active profile (CLAUDE_MEM_OPENAI_COMPATIBLE_PROFILES) or OPENAI_API_KEY environment variable.');
      }

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query provider with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryChatCompletionsMultiTurn(session.conversationHistory, requestUrl, apiKey, model, headers, maxContextTokens);

      if (initResponse.content) {
        // Add response to conversation history
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response (no original timestamp for init - not from queue)
        await this.processProviderResponse(session, initResponse.content, worker, tokensUsed, null);
      } else {
        logger.warn('SDK', 'Empty OpenAI-compatible init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // Build observation prompt
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Add to conversation history and query provider with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryChatCompletionsMultiTurn(session.conversationHistory, requestUrl, apiKey, model, headers, maxContextTokens);

          if (obsResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            const tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
            await this.processProviderResponse(session, obsResponse.content, worker, tokensUsed, originalTimestamp);
          } else {
            // Empty response - still mark messages as processed to avoid stuck state
            logger.warn('SDK', 'Empty OpenAI-compatible response for observation, marking as processed', {
              sessionId: session.sessionDbId,
              toolName: message.tool_name
            });
            await this.markMessagesProcessed(session, worker);
          }

        } else if (message.type === 'summarize') {
          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_user_message: message.last_user_message || '',
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query provider with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryChatCompletionsMultiTurn(session.conversationHistory, requestUrl, apiKey, model, headers, maxContextTokens);

          if (summaryResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            const tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
            await this.processProviderResponse(session, summaryResponse.content, worker, tokensUsed, originalTimestamp);
          } else {
            // Empty response - still mark messages as processed to avoid stuck state
            logger.warn('SDK', 'Empty OpenAI-compatible response for summary, marking as processed', {
              sessionId: session.sessionDbId
            });
            await this.markMessagesProcessed(session, worker);
          }
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenAI-compatible agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'OpenAI-compatible agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      if (this.shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenAI-compatible API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error.message,
          historyLength: session.conversationHistory.length
        });

        // Reset any 'processing' messages back to 'pending' so Claude can retry them
        const pendingStore = this.sessionManager.getPendingMessageStore();
        const resetCount = pendingStore.resetStuckMessages(0); // 0 = reset ALL processing messages
        if (resetCount > 0) {
          logger.info('SDK', 'Reset processing messages for fallback', {
            sessionDbId: session.sessionDbId,
            resetCount
          });
        }

        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenAI-compatible agent error', { sessionDbId: session.sessionDbId }, error);
      throw error;
    }
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Keeps most recent messages within token budget
   */
  private truncateHistory(
    history: ConversationMessage[],
    maxContextMessages: number = DEFAULT_MAX_CONTEXT_MESSAGES,
    maxEstimatedTokens: number = DEFAULT_MAX_ESTIMATED_TOKENS
  ): ConversationMessage[] {
    const MAX_CONTEXT_MESSAGES = maxContextMessages;
    const MAX_ESTIMATED_TOKENS = maxEstimatedTokens;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      // Check token count even if message count is ok
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    if (history.length === 0) return [];

    // Always keep the initial prompt (usually contains formatting/mode instructions)
    const first = history[0];
    const firstTokens = this.estimateTokens(first.content);

    if (MAX_CONTEXT_MESSAGES <= 1) {
      return [first];
    }

    // Sliding window: keep most recent messages within limits (while preserving the first message)
    const tail: ConversationMessage[] = [];
    let tokenCount = firstTokens;

    // Process messages in reverse (most recent first), skipping the first message
    for (let i = history.length - 1; i >= 1; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (tail.length >= MAX_CONTEXT_MESSAGES - 1 || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        const keptMessages = 1 + tail.length;
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages,
          droppedMessages: history.length - keptMessages,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      tail.unshift(msg);
      tokenCount += msgTokens;
    }

    return [first, ...tail];
  }

  /**
   * Convert shared ConversationMessage array to OpenAI-compatible message format
   */
  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * Query a Chat Completions-compatible endpoint with full conversation history (multi-turn)
   */
  private async queryChatCompletionsMultiTurn(
    history: ConversationMessage[],
    requestUrl: string,
    apiKey: string,
    model: string,
    extraHeaders?: Record<string, string>,
    maxContextTokens?: number
  ): Promise<{ content: string; tokensUsed?: number }> {
    const budgetingEnabled = typeof maxContextTokens === 'number' && Number.isFinite(maxContextTokens) && maxContextTokens > 0;

    let effectiveMaxContextTokens = maxContextTokens ?? DEFAULT_MAX_ESTIMATED_TOKENS;
    let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
    let promptBudgetTokens = DEFAULT_MAX_ESTIMATED_TOKENS;

    if (budgetingEnabled) {
      effectiveMaxContextTokens = maxContextTokens as number;
      maxOutputTokens = this.computeMaxOutputTokens(effectiveMaxContextTokens);
      promptBudgetTokens = Math.max(0, effectiveMaxContextTokens - maxOutputTokens - SAFETY_BUFFER_TOKENS);

      const fittedHistory = await this.fitHistoryToPromptBudget(
        history,
        promptBudgetTokens,
        requestUrl,
        apiKey,
        model,
        extraHeaders,
        effectiveMaxContextTokens
      );

      // Write back to shared conversationHistory so future turns stay compressed
      history.splice(0, history.length, ...fittedHistory);
    }

    let attempt = 0;
    let lastError: { status: number; text: string } | null = null;

    while (attempt < 2) {
      // If budgeting is enabled, we already wrote back a fitted history.
      // Otherwise, use a temporary truncated view without mutating the session history.
      const effectiveHistory = budgetingEnabled ? history : this.truncateHistory(history);
      const messages = this.conversationToOpenAIMessages(effectiveHistory);

      const totalChars = effectiveHistory.reduce((sum, m) => sum + m.content.length, 0);
      const estimatedPromptTokens = effectiveHistory.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

      logger.debug('SDK', `Querying OpenAI-compatible multi-turn (${model})`, {
        turns: effectiveHistory.length,
        totalChars,
        estimatedPromptTokens,
        ...(budgetingEnabled
          ? {
              maxOutputTokens,
              promptBudgetTokens,
              maxContextTokens: effectiveMaxContextTokens
            }
          : {})
      });

      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          ...(extraHeaders || {}),
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
          max_tokens: maxOutputTokens,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as OpenAICompatibleResponse;

        if (data.error) {
          throw new Error(`OpenAI-compatible API error: ${data.error.message || 'Unknown error'}`);
        }

        const content = data.choices?.[0]?.message?.content || '';
        const tokensUsed = data.usage?.total_tokens;

        if (!content) {
          logger.warn('SDK', 'OpenAI-compatible returned empty response content', {});
        }

        // Log token usage if available
        if (data.usage) {
          const { prompt_tokens, completion_tokens, total_tokens } = data.usage;
          logger.info('SDK', 'OpenAI-compatible token usage', {
            prompt_tokens,
            completion_tokens,
            total_tokens
          });
        }

        return { content, tokensUsed };
      }

      const errorText = await response.text();
      lastError = { status: response.status, text: errorText };

      if (attempt === 0 && budgetingEnabled && this.isLikelyContextLimitError(response.status, errorText)) {
        logger.warn('SDK', 'OpenAI-compatible context limit hit; retrying with tighter budget', {
          status: response.status,
          maxOutputTokens,
          maxContextTokens: effectiveMaxContextTokens
        });

        // Reduce output tokens and recompute prompt budget to increase headroom
        maxOutputTokens = Math.max(1, Math.floor(maxOutputTokens * 0.5));
        promptBudgetTokens = Math.max(0, effectiveMaxContextTokens - maxOutputTokens - SAFETY_BUFFER_TOKENS);

        const retryHistory = await this.fitHistoryToPromptBudget(
          history,
          promptBudgetTokens,
          requestUrl,
          apiKey,
          model,
          extraHeaders,
          effectiveMaxContextTokens,
          { force: true }
        );

        history.splice(0, history.length, ...retryHistory);
        attempt++;
        continue;
      }

      throw new Error(`OpenAI-compatible API error: ${response.status} - ${errorText}`);
    }

    throw new Error(
      lastError
        ? `OpenAI-compatible API error: ${lastError.status} - ${lastError.text}`
        : 'OpenAI-compatible API error: Unknown error'
    );
  }


  /**
   * Compute max_tokens for Chat Completions while keeping room for the prompt.
   */
  private computeMaxOutputTokens(maxContextTokens: number): number {
    // Reserve safety buffer + minimum prompt budget
    const maxAllowed = Math.max(1, maxContextTokens - SAFETY_BUFFER_TOKENS - MIN_PROMPT_BUDGET_TOKENS);

    const desiredByRatio = Math.floor(maxContextTokens * DEFAULT_OUTPUT_TOKEN_RATIO);
    const desired = Math.min(
      DEFAULT_MAX_OUTPUT_TOKENS,
      desiredByRatio > 0 ? desiredByRatio : DEFAULT_MAX_OUTPUT_TOKENS
    );

    // Prefer at least MIN_OUTPUT_TOKENS when possible, but never exceed maxAllowed
    const clamped = Math.min(Math.max(desired, MIN_OUTPUT_TOKENS), maxAllowed);
    return Math.max(1, clamped);
  }

  /**
   * Detect provider errors that are likely caused by exceeding context/token limits.
   */
  private isLikelyContextLimitError(status: number, errorText: string): boolean {
    if (![400, 413, 422].includes(status)) return false;

    const text = (errorText || '').toLowerCase();
    const mentionsTokens = text.includes('token') || text.includes('tokens') || text.includes('max_tokens');
    const mentionsContext =
      text.includes('context') || text.includes('context length') || text.includes('context window');
    const mentionsTooLong =
      text.includes('too long') ||
      text.includes('exceed') ||
      text.includes('exceeded') ||
      text.includes('maximum') ||
      text.includes('limit');

    return (
      (mentionsContext && (mentionsTokens || mentionsTooLong)) ||
      (mentionsTokens && mentionsTooLong) ||
      text.includes('request too large') ||
      text.includes('payload too large')
    );
  }

  /**
   * Fit conversation history into a prompt token budget.
   * Strategy: rolling summary compression (keep init prompt + last N messages), then truncation as a fallback.
   */
  private async fitHistoryToPromptBudget(
    history: ConversationMessage[],
    promptBudgetTokens: number,
    requestUrl: string,
    apiKey: string,
    model: string,
    extraHeaders: Record<string, string> | undefined,
    maxContextTokens: number,
    options?: { force?: boolean }
  ): Promise<ConversationMessage[]> {
    let working = history.slice();

    const estimatedTokens = working.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    const needsWork =
      options?.force === true ||
      working.length > DEFAULT_MAX_CONTEXT_MESSAGES ||
      estimatedTokens > promptBudgetTokens;

    if (!needsWork) {
      return working;
    }

    logger.info('SDK', 'Fitting conversation history to prompt budget', {
      originalMessages: history.length,
      originalEstimatedTokens: estimatedTokens,
      promptBudgetTokens,
      maxContextTokens
    });

    for (let pass = 0; pass < MAX_CONTEXT_COMPRESSION_PASSES; pass++) {
      const tokensNow = working.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (working.length <= DEFAULT_MAX_CONTEXT_MESSAGES && tokensNow <= promptBudgetTokens) {
        return working;
      }

      const canCompress = working.length > 1 + KEEP_RECENT_MESSAGES_FOR_SUMMARY;
      if (!canCompress) {
        break;
      }

      const beforeMessages = working.length;
      const beforeTokens = tokensNow;

      working = await this.compressHistoryWithRollingSummary(
        working,
        requestUrl,
        apiKey,
        model,
        extraHeaders,
        maxContextTokens
      );

      const afterTokens = working.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

      logger.info('SDK', 'Applied rolling summary compression pass', {
        pass: pass + 1,
        beforeMessages,
        afterMessages: working.length,
        beforeEstimatedTokens: beforeTokens,
        afterEstimatedTokens: afterTokens
      });
    }

    // Final fallback: truncate while preserving the initial prompt
    const truncated = this.truncateHistory(working, DEFAULT_MAX_CONTEXT_MESSAGES, promptBudgetTokens);
    const truncatedTokens = truncated.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    logger.warn('SDK', 'Falling back to truncation after compression passes', {
      finalMessages: truncated.length,
      finalEstimatedTokens: truncatedTokens,
      promptBudgetTokens
    });

    return truncated;
  }

  /**
   * One compression pass: summarize the middle portion of history into a single message.
   */
  private async compressHistoryWithRollingSummary(
    history: ConversationMessage[],
    requestUrl: string,
    apiKey: string,
    model: string,
    extraHeaders: Record<string, string> | undefined,
    maxContextTokens: number
  ): Promise<ConversationMessage[]> {
    if (history.length === 0) return [];

    const first = history[0];
    const keepRecentCount = Math.min(KEEP_RECENT_MESSAGES_FOR_SUMMARY, Math.max(0, history.length - 1));
    const middleEnd = Math.max(1, history.length - keepRecentCount);

    const middle = history.slice(1, middleEnd);
    const recent = history.slice(middleEnd);

    if (middle.length === 0) {
      return history;
    }

    let summaryText = '';
    try {
      summaryText = await this.summarizeMessagesForCompression(
        middle,
        requestUrl,
        apiKey,
        model,
        extraHeaders,
        maxContextTokens
      );
    } catch (error: any) {
      logger.warn('SDK', 'Rolling summary compression failed; omitting older messages', {}, error);
      summaryText = '';
    }

    const summaryMessage: ConversationMessage = summaryText
      ? {
          role: 'user',
          content: `Context summary (older messages, compressed):\n\n${summaryText}`
        }
      : {
          role: 'user',
          content: 'Context summary unavailable; older messages were omitted to fit within the prompt budget.'
        };

    return [first, summaryMessage, ...recent];
  }

  private async summarizeMessagesForCompression(
    messages: ConversationMessage[],
    requestUrl: string,
    apiKey: string,
    model: string,
    extraHeaders: Record<string, string> | undefined,
    maxContextTokens: number
  ): Promise<string> {
    const transcript = this.formatMessagesForCompression(messages);

    // Keep this summarization request itself within the model context window.
    const internalPromptBudgetTokens = Math.max(
      512,
      maxContextTokens - SAFETY_BUFFER_TOKENS - INTERNAL_SUMMARY_MAX_OUTPUT_TOKENS
    );

    // Leave room for instructions and wrappers inside the summarization prompt.
    const maxChunkTokens = Math.max(256, internalPromptBudgetTokens - 512);
    const maxChunkChars = maxChunkTokens * CHARS_PER_TOKEN_ESTIMATE;

    const chunks = this.splitTextIntoChunksByChars(transcript, maxChunkChars);
    const summaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const prompt = this.buildInternalSummaryPrompt(chunks[i], i + 1, chunks.length);
      const chunkSummary = await this.queryChatCompletionsSingleTurn(
        prompt,
        requestUrl,
        apiKey,
        model,
        extraHeaders,
        INTERNAL_SUMMARY_MAX_OUTPUT_TOKENS
      );

      const cleaned = this.sanitizeInternalSummaryText(chunkSummary);
      if (cleaned) {
        summaries.push(cleaned);
      }
    }

    return summaries.join('\n\n');
  }

  private formatMessagesForCompression(messages: ConversationMessage[]): string {
    return messages
      .map((m, idx) => {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        return `--- message ${idx + 1} (${role}) ---\n${m.content}`;
      })
      .join('\n\n');
  }

  private splitTextIntoChunksByChars(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      chunks.push(text.slice(i, i + maxChars));
    }
    return chunks;
  }

  private buildInternalSummaryPrompt(chunk: string, part: number, totalParts: number): string {
    return [
      'You are compressing conversation history for a tool-usage observation extractor.',
      `Summarize the following transcript chunk (part ${part} of ${totalParts}).`,
      '',
      'Rules:',
      '- Preserve critical technical details: file paths, commands, IDs, errors, config values, decisions.',
      '- Do NOT output any XML/tags. Specifically, DO NOT output <observation> or <summary> tags.',
      '- Output plain text only.',
      '',
      '--- BEGIN TRANSCRIPT ---',
      chunk,
      '--- END TRANSCRIPT ---'
    ].join('\n');
  }

  private sanitizeInternalSummaryText(text: string): string {
    return (text || '')
      .replace(/<\s*observation\b[^>]*>/gi, '')
      .replace(/<\/\s*observation\s*>/gi, '')
      .replace(/<\s*summary\b[^>]*>/gi, '')
      .replace(/<\/\s*summary\s*>/gi, '')
      .trim();
  }

  private async queryChatCompletionsSingleTurn(
    prompt: string,
    requestUrl: string,
    apiKey: string,
    model: string,
    extraHeaders: Record<string, string> | undefined,
    maxTokens: number
  ): Promise<string> {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        ...(extraHeaders || {}),
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI-compatible summarization error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as OpenAICompatibleResponse;

    if (data.error) {
      throw new Error(`OpenAI-compatible summarization error: ${data.error.message || 'Unknown error'}`);
    }

    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Process and store provider response (XML parsing + DB + SSE)
   */
  private async processProviderResponse(
    session: ActiveSession,
    text: string,
    worker: any | undefined,
    discoveryTokens: number,
    originalTimestamp: number | null
  ): Promise<void> {
    const store = this.dbManager.getSessionStore();

    // Parse observations
    const observations = parseObservations(text);
    for (const obs of observations) {
      const createdAtEpoch = originalTimestamp ?? Date.now();
      const observationId = store.storeObservation({
        memory_session_id: session.memorySessionId!,
        project: session.project,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        text: obs.text,
        concepts: obs.concepts,
        files: obs.files,
        prompt_number: session.lastPromptNumber,
        created_at_epoch: createdAtEpoch,
        read_tokens: 0,
        work_tokens: discoveryTokens
      });

      // Sync to Chroma (async)
      this.dbManager.getChromaSync()?.syncObservation(observationId).catch(err => {
        logger.debug('CHROMA', 'Failed to sync observation', { id: observationId }, err);
      });

      // Broadcast to SSE clients
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_observation',
          observation: {
            id: observationId,
            memory_session_id: session.memorySessionId!,
            project: session.project,
            type: obs.type,
            title: obs.title,
            subtitle: obs.subtitle,
            narrative: obs.text,
            text: obs.text,
            facts: null,
            concepts: obs.concepts.join(','),
            files_read: obs.files.join(','),
            files_modified: null,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch,
            created_at: new Date(createdAtEpoch).toISOString(),
          }
        });
      }
    }

    // Parse and store summary if present
    const summary = parseSummary(text);
    if (summary) {
      const createdAtEpoch = originalTimestamp ?? Date.now();
      const summaryId = store.storeSummary({
        memory_session_id: session.memorySessionId!,
        project: session.project,
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        next_steps: summary.next_steps,
        notes: summary.notes,
        prompt_number: session.lastPromptNumber,
        created_at_epoch: createdAtEpoch
      });

      // Broadcast to SSE clients
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_summary',
          summary: {
            id: summaryId,
            session_id: session.contentSessionId,
            request: summary.request,
            investigated: summary.investigated,
            learned: summary.learned,
            completed: summary.completed,
            next_steps: summary.next_steps,
            notes: summary.notes,
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }

      // Update Cursor context file for registered projects (fire-and-forget)
      updateCursorContextForProject(session.project, getWorkerPort()).catch(() => {});
    }

    // Mark messages as processed
    await this.markMessagesProcessed(session, worker);
  }

  /**
   * Mark pending messages as processed
   */
  private async markMessagesProcessed(session: ActiveSession, worker: any | undefined): Promise<void> {
    const pendingMessageStore = this.sessionManager.getPendingMessageStore();
    if (session.pendingProcessingIds.size > 0) {
      for (const messageId of session.pendingProcessingIds) {
        pendingMessageStore.markProcessed(messageId);
      }
      logger.debug('SDK', 'OpenAI-compatible messages marked as processed', {
        sessionId: session.sessionDbId,
        count: session.pendingProcessingIds.size
      });
      session.pendingProcessingIds.clear();

      const deletedCount = pendingMessageStore.cleanupProcessed(100);
      if (deletedCount > 0) {
        logger.debug('SDK', 'OpenAI-compatible cleaned up old processed messages', { deletedCount });
      }
    }

    if (worker && typeof worker.broadcastProcessingStatus === 'function') {
      worker.broadcastProcessingStatus();
    }
  }

  /**
   * Get OpenAI-compatible configuration from settings (active profile)
   */
  private getOpenAICompatibleConfig(): {
    requestUrl: string;
    apiKey: string;
    model: string;
    headers?: Record<string, string>;
    maxContextTokens?: number;
  } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const profilesJson = settings.CLAUDE_MEM_OPENAI_COMPATIBLE_PROFILES || '[]';
    const profiles = safeParseProfiles(profilesJson);
    const activeId = settings.CLAUDE_MEM_OPENAI_COMPATIBLE_ACTIVE_PROFILE || '';

    const profile = pickActiveProfile(profiles, activeId);
    if (!profile) {
      return { requestUrl: '', apiKey: '', model: '', headers: {} };
    }

    const apiKey = profile.apiKey || process.env.OPENAI_API_KEY || '';
    const headers = (profile.headers && typeof profile.headers === 'object' && !Array.isArray(profile.headers))
      ? profile.headers
      : {};

    const rawMaxContextTokens = (profile as any).maxContextTokens;
    const maxContextTokens = typeof rawMaxContextTokens === 'number'
      ? rawMaxContextTokens
      : (typeof rawMaxContextTokens === 'string' && /^\d+$/.test(rawMaxContextTokens)
        ? parseInt(rawMaxContextTokens, 10)
        : undefined);

    let requestUrl = '';
    try {
      requestUrl = new URL(profile.chatCompletionsPath, profile.baseUrl).toString();
    } catch {
      requestUrl = '';
    }

    return {
      requestUrl,
      apiKey,
      model: profile.model || '',
      headers,
      maxContextTokens
    };
  }
}

/**
 * Check if OpenAI-compatible provider is available (has a usable active profile)
 */
export function isOpenAICompatibleAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const profiles = safeParseProfiles(settings.CLAUDE_MEM_OPENAI_COMPATIBLE_PROFILES || '[]');
  const profile = pickActiveProfile(profiles, settings.CLAUDE_MEM_OPENAI_COMPATIBLE_ACTIVE_PROFILE || '');
  if (!profile) return false;

  const apiKey = profile.apiKey || process.env.OPENAI_API_KEY || '';
  try {
    new URL(profile.chatCompletionsPath, profile.baseUrl);
  } catch {
    return false;
  }

  return !!apiKey;
}

/**
 * Check if OpenAI-compatible provider is the selected provider
 */
export function isOpenAICompatibleSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-compatible';
}

/**
 * OpenRouterAgent: OpenRouter-based observation extraction
 *
 * Alternative to SDKAgent that uses OpenRouter's unified API
 * for accessing 100+ models from different providers.
 *
 * Responsibility:
 * - Call OpenRouter REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection across providers
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

// OpenRouter API endpoint
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token ≈ 4 chars

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenRouterResponse {
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

// Forward declaration for fallback agent type
type FallbackAgent = {
  startSession(session: ActiveSession, worker?: any): Promise<void>;
};

export class OpenRouterAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when OpenRouter API fails
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
   * Start OpenRouter agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: any): Promise<void> {
    try {
      // Get OpenRouter configuration
      const { apiKey, model, siteUrl, appName } = this.getOpenRouterConfig();

      if (!apiKey) {
        throw new Error('OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query OpenRouter with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

      if (initResponse.content) {
        // Add response to conversation history
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response (no original timestamp for init - not from queue)
        await this.processOpenRouterResponse(session, initResponse.content, worker, tokensUsed, null);
      } else {
        logger.warn('SDK', 'Empty OpenRouter init response - session may lack context', {
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

          // Add to conversation history and query OpenRouter with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

          if (obsResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            const tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
            await this.processOpenRouterResponse(session, obsResponse.content, worker, tokensUsed, originalTimestamp);
          } else {
            // Empty response - still mark messages as processed to avoid stuck state
            logger.warn('SDK', 'Empty OpenRouter response for observation, marking as processed', {
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
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query OpenRouter with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

          if (summaryResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            const tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
            await this.processOpenRouterResponse(session, summaryResponse.content, worker, tokensUsed, originalTimestamp);
          } else {
            // Empty response - still mark messages as processed to avoid stuck state
            logger.warn('SDK', 'Empty OpenRouter response for summary, marking as processed', {
              sessionId: session.sessionDbId
            });
            await this.markMessagesProcessed(session, worker);
          }
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenRouter agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'OpenRouter agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      if (this.shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenRouter API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error.message,
          historyLength: session.conversationHistory.length
        });

        // Reset any 'processing' messages back to 'pending' so Claude can retry them
        const pendingStore = this.sessionManager.getPendingMessageStore();
        const resetCount = pendingStore.resetStuckMessages(0);  // 0 = reset ALL processing messages
        if (resetCount > 0) {
          logger.info('SDK', 'Reset processing messages for fallback', {
            sessionDbId: session.sessionDbId,
            resetCount
          });
        }

        // Fall back to Claude - it will use the same session with shared conversationHistory
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenRouter agent error', { sessionDbId: session.sessionDbId }, error);
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
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(
      USER_SETTINGS_PATH
    );

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      // Check token count even if message count is ok
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    // Process messages in reverse (most recent first)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  // Add to beginning
      tokenCount += msgTokens;
    }

    return truncated;
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
   * Query OpenRouter via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    // Truncate history to prevent runaway costs
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': siteUrl || 'https://github.com/thedotmack/claude-mem',
        'X-Title': appName || 'claude-mem',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,  // Lower temperature for structured extraction
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenRouterResponse;

    // Check for API error in response body
    if (data.error) {
      throw new Error(`OpenRouter API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.warn('SDK', 'Empty response from OpenRouter');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;

    // Log actual token usage for cost tracking
    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      // Token usage (cost varies by model - many OpenRouter models are free)
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'OpenRouter API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: truncatedHistory.length
      });

      // Warn if costs are getting high
      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed };
  }

  /**
   * Process OpenRouter response (same format as Claude/Gemini)
   * @param originalTimestamp - Original epoch when message was queued (for backlog processing accuracy)
   */
  private async processOpenRouterResponse(
    session: ActiveSession,
    text: string,
    worker: any | undefined,
    discoveryTokens: number,
    originalTimestamp: number | null
  ): Promise<void> {
    // Parse observations (same XML format)
    const observations = parseObservations(text, session.contentSessionId);

    // Store observations with original timestamp (if processing backlog) or current time
    for (const obs of observations) {
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.contentSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      logger.info('SDK', 'OpenRouter observation saved', {
        sessionId: session.sessionDbId,
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      });

      // Sync to Chroma
      this.dbManager.getChromaSync().syncObservation(
        obsId,
        session.contentSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).catch(err => {
        logger.warn('SDK', 'OpenRouter chroma sync failed', { obsId }, err);
      });

      // Broadcast to SSE clients
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_observation',
          observation: {
            id: obsId,
            memory_session_id: session.memorySessionId,
            session_id: session.contentSessionId,
            type: obs.type,
            title: obs.title,
            subtitle: obs.subtitle,
            text: null,
            narrative: obs.narrative || null,
            facts: JSON.stringify(obs.facts || []),
            concepts: JSON.stringify(obs.concepts || []),
            files_read: JSON.stringify(obs.files_read || []),
            files_modified: JSON.stringify(obs.files_modified || []),
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }
    }

    // Parse summary
    const summary = parseSummary(text, session.sessionDbId);

    if (summary) {
      // Convert nullable fields to empty strings for storeSummary
      const summaryForStore = {
        request: summary.request || '',
        investigated: summary.investigated || '',
        learned: summary.learned || '',
        completed: summary.completed || '',
        next_steps: summary.next_steps || '',
        notes: summary.notes
      };

      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.contentSessionId,
        session.project,
        summaryForStore,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      logger.info('SDK', 'OpenRouter summary saved', {
        sessionId: session.sessionDbId,
        summaryId,
        request: summary.request || '(no request)'
      });

      // Sync to Chroma
      this.dbManager.getChromaSync().syncSummary(
        summaryId,
        session.contentSessionId,
        session.project,
        summaryForStore,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).catch(err => {
        logger.warn('SDK', 'OpenRouter chroma sync failed', { summaryId }, err);
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
      updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
        logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
      });
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
      logger.debug('SDK', 'OpenRouter messages marked as processed', {
        sessionId: session.sessionDbId,
        count: session.pendingProcessingIds.size
      });
      session.pendingProcessingIds.clear();

      const deletedCount = pendingMessageStore.cleanupProcessed(100);
      if (deletedCount > 0) {
        logger.debug('SDK', 'OpenRouter cleaned up old processed messages', { deletedCount });
      }
    }

    if (worker && typeof worker.broadcastProcessingStatus === 'function') {
      worker.broadcastProcessingStatus();
    }
  }

  /**
   * Get OpenRouter configuration from settings or environment
   */
  private getOpenRouterConfig(): { apiKey: string; model: string; siteUrl?: string; appName?: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then environment variable
    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';

    // Model: from settings or default
    const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';

    // Optional analytics headers
    const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem';

    return { apiKey, model, siteUrl, appName };
  }
}

/**
 * Check if OpenRouter is available (has API key configured)
 */
export function isOpenRouterAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY);
}

/**
 * Check if OpenRouter is the selected provider
 */
export function isOpenRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}

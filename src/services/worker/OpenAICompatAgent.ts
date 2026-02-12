/**
 * OpenAICompatAgent: OpenAI-compatible API observation extraction
 *
 * Generic OpenAI-compatible chat completions client that works with
 * any provider supporting the OpenAI API format (OpenRouter, cli-proxy,
 * local models, etc.).
 *
 * Responsibility:
 * - Call OpenAI-compatible REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection across providers
 */

import { randomUUID } from 'crypto';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt, buildSummaryContextPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getCredential } from '../../shared/EnvManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Default API endpoint (OpenRouter as convenience default, overridable via CLAUDE_MEM_OPENAI_COMPAT_BASE_URL)
const DEFAULT_OPENAI_COMPAT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// History compaction constants
const COMPACT_THRESHOLD = 14;  // Compact when history exceeds 14 messages (7 turns)
const KEEP_RECENT = 6;         // Keep last 6 messages (3 recent turns) after compaction

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAICompatResponse {
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

export class OpenAICompatAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when OpenAI-compatible API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Compact conversation history to preserve instructions and session context.
   * Replaces blind truncation by keeping: [initPrompt, summaryContext, ...recentMessages]
   * Only triggers when history exceeds COMPACT_THRESHOLD.
   */
  private compactHistory(session: ActiveSession): void {
    const history = session.conversationHistory;
    if (history.length <= COMPACT_THRESHOLD) {
      return;
    }

    const originalLength = history.length;

    // Read current summary from DB
    let summaryContext: string;
    try {
      const memorySessionId = session.memorySessionId;
      const summary = memorySessionId
        ? this.dbManager.getSessionStore().getSummaryForSession(memorySessionId)
        : null;
      summaryContext = buildSummaryContextPrompt(summary);
    } catch (error) {
      logger.warn('SDK', 'Failed to read summary for compaction, using empty context', {
        sessionId: session.sessionDbId,
        error: error instanceof Error ? error.message : String(error)
      });
      summaryContext = buildSummaryContextPrompt(null);
    }

    // Rebuild: [initPrompt, summaryContext, ...recentMessages]
    const initPrompt = history[0];
    const recentMessages = history.slice(-KEEP_RECENT);

    session.conversationHistory = [
      initPrompt,
      { role: 'user', content: summaryContext },
      ...recentMessages
    ];

    logger.info('SDK', 'Compacted history', {
      sessionId: session.sessionDbId,
      before: originalLength,
      after: session.conversationHistory.length,
      keptRecent: KEEP_RECENT
    });
  }

  /**
   * Start OpenAI-compatible agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get OpenAI-compatible API configuration
      const { apiKey, model, siteUrl, appName, baseUrl } = this.getOpenAICompatConfig();

      if (!apiKey) {
        throw new Error('OpenAI-compatible API key not configured. Set CLAUDE_MEM_OPENAI_COMPAT_API_KEY in settings or OPENAI_COMPAT_API_KEY environment variable.');
      }

      // Ensure memorySessionId is set (OpenAI-compatible API doesn't get session IDs from SDK responses)
      // This must happen before any processAgentResponse() calls which require it for the FK constraint
      // IMPORTANT: Reuse existing DB value to avoid FK violations with existing observations/summaries.
      // Only generate a new UUID for truly new sessions that have no memory_session_id yet.
      if (!session.memorySessionId) {
        const dbSession = this.dbManager.getSessionById(session.sessionDbId);
        const existingId = dbSession?.memory_session_id;
        if (existingId) {
          session.memorySessionId = existingId;
          logger.info('SESSION', `Restored memorySessionId from database for OpenAI-compat session`, {
            sessionId: session.sessionDbId,
            memorySessionId: existingId
          });
        } else {
          const generatedId = randomUUID();
          session.memorySessionId = generatedId;
          this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, generatedId);
          logger.info('SESSION', `Generated memorySessionId for OpenAI-compat session`, {
            sessionId: session.sessionDbId,
            memorySessionId: generatedId
          });
        }
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history, compact if needed, and query with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      this.compactHistory(session);
      const initResponse = await this.queryOpenAICompatMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName, baseUrl);

      if (initResponse.content) {
        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'OpenAI-Compat',
          undefined,  // No lastCwd yet - before message processing
          true  // skipSummaryStorage: prevent feedback loop in compactHistory
        );
      } else {
        logger.error('SDK', 'Empty OpenAI-compat init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Track lastCwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture cwd from messages for proper worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
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

          // Add to conversation history, compact if needed, and query with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          this.compactHistory(session);
          const obsResponse = await this.queryOpenAICompatMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName, baseUrl);

          let tokensUsed = 0;
          if (obsResponse.content) {
            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAI-Compat',
            lastCwd,
            true  // skipSummaryStorage: prevent feedback loop in compactHistory
          );

        } else if (message.type === 'summarize') {
          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history, compact if needed, and query with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          this.compactHistory(session);
          const summaryResponse = await this.queryOpenAICompatMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName, baseUrl);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAI-Compat',
            lastCwd
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenAI-compat agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'OpenAI-compat agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenAI-compat API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        // Fall back to Claude - it will use the same session with shared conversationHistory
        // Note: With claim-and-delete queue pattern, messages are already deleted on claim
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenAI-compat agent error', { sessionDbId: session.sessionDbId }, error as Error);
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
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

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
   * Query OpenAI-compatible API via REST with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryOpenAICompatMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    siteUrl?: string,
    appName?: string,
    baseUrl?: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    // Truncate history to prevent runaway costs
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    const apiUrl = baseUrl || DEFAULT_OPENAI_COMPAT_API_URL;
    logger.debug('SDK', `Querying OpenAI-compat multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens,
      apiUrl
    });

    const response = await fetch(apiUrl, {
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
      throw new Error(`OpenAI-compat API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenAICompatResponse;

    // Check for API error in response body
    if (data.error) {
      throw new Error(`OpenAI-compat API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OpenAI-compat API');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;

    // Log actual token usage for cost tracking
    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      // Token usage (cost varies by model - many models are free)
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'OpenAI-compat API usage', {
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
   * Get OpenAI-compatible API configuration from settings or environment
   * Issue #733: Uses centralized ~/.claude-mem/.env for credentials, not random project .env files
   */
  private getOpenAICompatConfig(): { apiKey: string; model: string; siteUrl?: string; appName?: string; baseUrl: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then centralized claude-mem .env (NOT process.env)
    // This prevents Issue #733 where random project .env files could interfere
    const apiKey = settings.CLAUDE_MEM_OPENAI_COMPAT_API_KEY || getCredential('OPENAI_COMPAT_API_KEY') || '';

    // Model: from settings or default
    const model = settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL || 'xiaomi/mimo-v2-flash:free';

    // Optional analytics headers
    const siteUrl = settings.CLAUDE_MEM_OPENAI_COMPAT_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENAI_COMPAT_APP_NAME || 'claude-mem';

    // Base URL: allows using cli-proxy or other OpenAI-compatible endpoints
    const baseUrl = settings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL || DEFAULT_OPENAI_COMPAT_API_URL;

    return { apiKey, model, siteUrl, appName, baseUrl };
  }
}

/**
 * Check if OpenAI-compatible provider is available (has API key configured)
 * Issue #733: Uses centralized ~/.claude-mem/.env, not random project .env files
 */
export function isOpenAICompatAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENAI_COMPAT_API_KEY || getCredential('OPENAI_COMPAT_API_KEY'));
}

/**
 * Check if OpenAI-compatible is the selected provider
 */
export function isOpenAICompatSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-compat';
}

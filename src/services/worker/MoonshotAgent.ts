/**
 * MoonshotAgent: Moonshot AI (Kimi) based observation extraction
 *
 * Alternative to SDKAgent that uses Moonshot AI's OpenAI-compatible API
 * for accessing Kimi K2.5 and other Moonshot models.
 *
 * Responsibility:
 * - Call Moonshot AI REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';

// Moonshot API endpoint
const MOONSHOT_API_URL = 'https://api.moonshot.ai/v1/chat/completions';

// Context window management constants
const DEFAULT_MAX_CONTEXT_MESSAGES = 50;  // Kimi K2.5 supports 256k context
const DEFAULT_MAX_ESTIMATED_TOKENS = 250000;  // ~250k tokens max context (conservative for 256k limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars
const API_TIMEOUT_MS = 30000;  // 30 second timeout for API calls

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface MoonshotResponse {
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

export class MoonshotAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Moonshot API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Moonshot agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get Moonshot configuration
      const { apiKey, model, baseUrl } = this.getMoonshotConfig();

      if (!apiKey) {
        throw new Error('Moonshot API key not configured. Set CLAUDE_MEM_MOONSHOT_API_KEY in settings or MOONSHOT_API_KEY environment variable.');
      }

      // Generate synthetic memorySessionId (Moonshot is stateless, doesn't return session IDs)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `moonshot-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Moonshot`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Moonshot with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryMoonshotMultiTurn(session.conversationHistory, apiKey, model, baseUrl);

      if (initResponse.content) {
        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += initResponse.inputTokens || Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += initResponse.outputTokens || Math.floor(tokensUsed * 0.3);

        // Process response using shared ResponseProcessor
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Moonshot',
          undefined
        );
      } else {
        logger.error('SDK', 'Empty Moonshot init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Track lastCwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
        session.processingMessageIds.push(message._persistentId);

        // Update lastCwd if message has cwd
        if (message.cwd) {
          lastCwd = message.cwd;
        }

        // Load active mode (may have changed)
        const currentMode = ModeManager.getInstance().getActiveMode();

        // Build observation prompt
        const obsPrompt = buildObservationPrompt(
          message.tool_name,
          message.tool_input,
          message.tool_output,
          session.contentSessionId,
          currentMode
        );

        // Add to conversation history and query with full context
        session.conversationHistory.push({ role: 'user', content: obsPrompt });
        const response = await this.queryMoonshotMultiTurn(
          session.conversationHistory,
          apiKey,
          model,
          baseUrl
        );

        if (response.content) {
          // Track token usage
          const tokensUsed = response.tokensUsed || 0;
          session.cumulativeInputTokens += response.inputTokens || Math.floor(tokensUsed * 0.7);
          session.cumulativeOutputTokens += response.outputTokens || Math.floor(tokensUsed * 0.3);

          // Process response
          await processAgentResponse(
            response.content,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            message.timestamp,
            'Moonshot',
            lastCwd
          );
        } else {
          logger.warn('SDK', 'Empty Moonshot response for observation', {
            sessionId: session.sessionDbId,
            messageId: message._persistentId,
            tool: message.tool_name
          });
        }

        // Update last activity timestamp
        session.lastGeneratorActivity = Date.now();
      }

      // Check if summarization is needed
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const contextObservations = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10) || 50;

      // Get observation count from database
      const observationCount = this.dbManager.getSessionStore().getObservationCount(session.sessionDbId);

      if (observationCount >= contextObservations) {
        logger.info('SESSION', `Triggering summarization | count=${observationCount} | threshold=${contextObservations}`, {
          sessionId: session.sessionDbId
        });

        // Get last assistant message for context
        const lastAssistantMessage = session.conversationHistory
          .filter(m => m.role === 'assistant')
          .pop()?.content || '';

        // Build summary prompt
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_assistant_message: lastAssistantMessage
        }, currentMode);

        // Add to conversation history and query
        session.conversationHistory.push({ role: 'user', content: summaryPrompt });
        const summaryResponse = await this.queryMoonshotMultiTurn(
          session.conversationHistory,
          apiKey,
          model,
          baseUrl
        );

        if (summaryResponse.content) {
          // Track token usage
          const tokensUsed = summaryResponse.tokensUsed || 0;
          session.cumulativeInputTokens += summaryResponse.inputTokens || Math.floor(tokensUsed * 0.7);
          session.cumulativeOutputTokens += summaryResponse.outputTokens || Math.floor(tokensUsed * 0.3);

          // Process summary response
          await processAgentResponse(
            summaryResponse.content,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            null,
            'Moonshot',
            lastCwd
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Moonshot agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        totalTokens: session.cumulativeInputTokens + session.cumulativeOutputTokens
      });

    } catch (error) {
      // Check if this is a fatal error or if we should fallback
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Moonshot failed, falling back to Claude', {
          sessionId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error)
        });
        await this.fallbackAgent.startSession(session, worker);
        return;
      }

      // Check for abort errors (user cancelled)
      if (isAbortError(error)) {
        logger.info('SESSION', 'Moonshot session aborted by user', {
          sessionId: session.sessionDbId
        });
        throw error;
      }

      // Log and re-throw other errors
      logger.error('SESSION', 'Moonshot session failed', {
        sessionId: session.sessionDbId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Query Moonshot API with multi-turn conversation context
   */
  private async queryMoonshotMultiTurn(
    conversationHistory: ConversationMessage[],
    apiKey: string,
    model: string,
    baseUrl: string
  ): Promise<{ content: string; tokensUsed: number; inputTokens?: number; outputTokens?: number }> {
    // Build messages array from conversation history
    const messages: OpenAIMessage[] = conversationHistory.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content
    }));

    // Truncate if needed to fit context window
    const { maxContextMessages, maxEstimatedTokens } = this.getContextLimits();
    const truncatedMessages = this.truncateMessages(messages, maxContextMessages, maxEstimatedTokens);

    const requestBody = {
      model,
      messages: truncatedMessages,
      temperature: 0.1,  // Low temperature for consistent observation extraction
      max_tokens: 8192   // Kimi K2.5 supports up to 8192 output tokens
    };

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Moonshot API error: ${response.status} - ${errorText}`;

        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error?.message) {
            errorMessage = `Moonshot API error: ${errorJson.error.message}`;
          }
        } catch {
          // Use raw error text if JSON parsing fails
        }

        throw new Error(errorMessage);
      }

      const data: MoonshotResponse = await response.json();

      if (data.error?.message) {
        throw new Error(`Moonshot API error: ${data.error.message}`);
      }

      const content = data.choices?.[0]?.message?.content || '';
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      const totalTokens = data.usage?.total_tokens || (inputTokens + outputTokens);

      return {
        content,
        tokensUsed: totalTokens,
        inputTokens,
        outputTokens
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Moonshot API timeout after ${API_TIMEOUT_MS}ms`);
      }
      throw error;
    }
  }

  /**
   * Truncate messages to fit within context window limits
   */
  private truncateMessages(
    messages: OpenAIMessage[],
    maxMessages: number,
    maxEstimatedTokens: number
  ): OpenAIMessage[] {
    // First limit by message count
    let truncated = messages;
    if (messages.length > maxMessages) {
      // Keep first message (init prompt) and most recent messages
      const firstMessage = messages[0];
      const recentMessages = messages.slice(-(maxMessages - 1));
      truncated = [firstMessage, ...recentMessages];
      logger.debug('SDK', `Truncated conversation history to ${maxMessages} messages`, {
        originalCount: messages.length,
        truncatedCount: truncated.length
      });
    }

    // Then limit by estimated tokens
    let totalChars = truncated.reduce((sum, msg) => sum + msg.content.length, 0);
    const estimatedTokens = totalChars / CHARS_PER_TOKEN_ESTIMATE;

    if (estimatedTokens > maxEstimatedTokens) {
      // Keep removing oldest messages (except first) until we fit
      while (truncated.length > 1 && totalChars > maxEstimatedTokens * CHARS_PER_TOKEN_ESTIMATE) {
        const removed = truncated.splice(1, 1)[0];
        totalChars -= removed.content.length;
      }
      logger.debug('SDK', `Truncated conversation history to fit token limit`, {
        messages: truncated.length,
        estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)
      });
    }

    return truncated;
  }

  /**
   * Get context window limits from settings
   */
  private getContextLimits(): { maxContextMessages: number; maxEstimatedTokens: number } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return {
      maxContextMessages: parseInt(settings.CLAUDE_MEM_MOONSHOT_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES,
      maxEstimatedTokens: parseInt(settings.CLAUDE_MEM_MOONSHOT_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS
    };
  }

  /**
   * Get Moonshot configuration from settings
   */
  private getMoonshotConfig(): { apiKey: string; model: string; baseUrl: string } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Check for API key in settings or environment
    const apiKey = settings.CLAUDE_MEM_MOONSHOT_API_KEY || process.env.MOONSHOT_API_KEY || '';
    const model = settings.CLAUDE_MEM_MOONSHOT_MODEL || 'kimi-k2.5';
    const baseUrl = settings.CLAUDE_MEM_MOONSHOT_BASE_URL || MOONSHOT_API_URL;

    return { apiKey, model, baseUrl };
  }
}

/**
 * Check if Moonshot is the selected provider
 */
export function isMoonshotSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'moonshot' ||
         settings.CLAUDE_MEM_PROVIDER === 'kimi' ||
         settings.CLAUDE_MEM_PROVIDER === 'moonshot-ai';
}

/**
 * Check if Moonshot is available (has API key configured)
 */
export function isMoonshotAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const apiKey = settings.CLAUDE_MEM_MOONSHOT_API_KEY || process.env.MOONSHOT_API_KEY;
  return !!apiKey;
}

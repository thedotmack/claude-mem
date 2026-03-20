/**
 * OpenAICompatibleAgent: OpenAI-compatible API observation extraction
 *
 * Supports any service implementing the /v1/chat/completions API:
 * OpenAI, DeepSeek, Ollama, Azure OpenAI, DashScope/百炼, etc.
 *
 * Responsibility:
 * - Call any OpenAI-compatible REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini/OpenRouter)
 * - Sync to database and Chroma
 * - Support configurable base URL, model, and optional API key
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  estimateTokens,
  ProviderConfigurationError,
  truncateConversationHistory
} from '../../utils/error-messages.js';
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

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

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

export class OpenAICompatibleAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when the API fails
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start OpenAI-compatible agent for a session
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const { apiKey, baseUrl, model } = this.getConfig();

      if (!baseUrl) {
        throw new ProviderConfigurationError('OpenAI-compatible', 'CLAUDE_MEM_OPENAI_COMPATIBLE_BASE_URL');
      }

      if (!model) {
        throw new ProviderConfigurationError('OpenAI-compatible', 'CLAUDE_MEM_OPENAI_COMPATIBLE_MODEL');
      }

      // Generate synthetic memorySessionId (stateless REST API)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `openai-compatible-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenAI-Compatible`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryMultiTurn(session.conversationHistory, apiKey, baseUrl, model);

      if (initResponse.content) {
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'OpenAI-Compatible',
          undefined
        );
      } else {
        logger.error('SDK', 'Empty OpenAI-Compatible init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);

        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured.');
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
          const obsResponse = await this.queryMultiTurn(session.conversationHistory, apiKey, baseUrl, model);

          let tokensUsed = 0;
          if (obsResponse.content) {
            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAI-Compatible',
            lastCwd
          );

        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured.');
          }

          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryMultiTurn(session.conversationHistory, apiKey, baseUrl, model);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAI-Compatible',
            lastCwd
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenAI-Compatible agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'OpenAI-Compatible agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenAI-Compatible API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenAI-Compatible agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const maxMessages = parseInt(settings.CLAUDE_MEM_OPENAI_COMPATIBLE_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxTokens = parseInt(settings.CLAUDE_MEM_OPENAI_COMPATIBLE_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    return truncateConversationHistory(history, {
      maxMessages,
      maxTokens,
      charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
      providerName: 'OpenAI-Compatible'
    });
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  private async queryMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    baseUrl: string,
    model: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const estimatedTokens = estimateTokens(truncatedHistory.map(m => m.content).join(''), CHARS_PER_TOKEN_ESTIMATE);

    logger.debug('SDK', `Querying OpenAI-Compatible multi-turn (${model})`, {
      turns: truncatedHistory.length,
      estimatedTokens
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add Authorization header — use 'Bearer none' as safe fallback for local endpoints (e.g. Ollama)
    headers['Authorization'] = `Bearer ${apiKey || 'none'}`;

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI-Compatible API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenAICompatibleResponse;

    if (data.error) {
      throw new Error(`OpenAI-Compatible API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OpenAI-Compatible API');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;

    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      logger.info('SDK', 'OpenAI-Compatible API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        messagesInContext: truncatedHistory.length
      });
    }

    return { content, tokensUsed };
  }

  private getConfig(): { apiKey: string; baseUrl: string; model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // API key: settings file first, then OPENAI_API_KEY env var (optional for local endpoints)
    const apiKey = settings.CLAUDE_MEM_OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseUrl = settings.CLAUDE_MEM_OPENAI_COMPATIBLE_BASE_URL || '';
    const model = settings.CLAUDE_MEM_OPENAI_COMPATIBLE_MODEL || '';

    return { apiKey, baseUrl, model };
  }
}

/**
 * Check if OpenAI-compatible provider is available (base URL and model configured)
 * API key is optional for local endpoints like Ollama
 */
export function isOpenAICompatibleAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return !!(settings.CLAUDE_MEM_OPENAI_COMPATIBLE_BASE_URL && settings.CLAUDE_MEM_OPENAI_COMPATIBLE_MODEL);
}

/**
 * Check if OpenAI-compatible provider is selected
 */
export function isOpenAICompatibleSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-compatible';
}

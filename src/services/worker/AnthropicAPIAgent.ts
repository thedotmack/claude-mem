/**
 * AnthropicAPIAgent: Direct Anthropic API observation extraction
 *
 * Alternative to SDKAgent that uses Anthropic's Messages API directly
 * instead of spawning Claude CLI subprocesses.
 *
 * Responsibility:
 * - Call Anthropic REST API for observation extraction
 * - Parse XML responses (same format as other agents)
 * - Sync to database and Chroma
 *
 * Memory savings: ~1GB vs SDKAgent (no subprocess spawning)
 * Uses same API as SDKAgent but via HTTP instead of CLI
 */

import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Anthropic API endpoint
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Anthropic model types
export type AnthropicModel =
  | 'claude-sonnet-4-5'
  | 'claude-haiku-3-5'
  | 'claude-opus-4';

// API version header required by Anthropic
const ANTHROPIC_API_VERSION = '2023-06-01';

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AnthropicAPIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent for when Anthropic API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Anthropic API agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get Anthropic configuration
      const { apiKey, model } = this.getAnthropicConfig();

      if (!apiKey) {
        throw new Error('Anthropic API key not configured. Set CLAUDE_MEM_ANTHROPIC_API_KEY in settings or ANTHROPIC_API_KEY environment variable.');
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Anthropic with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, apiKey, model);

      if (initResponse.content) {
        // Add response to conversation history
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        session.cumulativeInputTokens += initResponse.inputTokens || 0;
        session.cumulativeOutputTokens += initResponse.outputTokens || 0;

        const discoveryTokens = (initResponse.inputTokens || 0) + (initResponse.outputTokens || 0);

        // Process response using shared ResponseProcessor
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          discoveryTokens,
          null,
          'Anthropic'
        );
      } else {
        logger.error('SDK', 'Empty Anthropic init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Process pending messages
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture cwd from each message for worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
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

          // Add to conversation history and query Anthropic with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, apiKey, model);

          let discoveryTokens = 0;
          if (obsResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            session.cumulativeInputTokens += obsResponse.inputTokens || 0;
            session.cumulativeOutputTokens += obsResponse.outputTokens || 0;
            discoveryTokens = (obsResponse.inputTokens || 0) + (obsResponse.outputTokens || 0);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            discoveryTokens,
            originalTimestamp,
            'Anthropic',
            lastCwd
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

          // Add to conversation history and query Anthropic with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, apiKey, model);

          let discoveryTokens = 0;
          if (summaryResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            session.cumulativeInputTokens += summaryResponse.inputTokens || 0;
            session.cumulativeOutputTokens += summaryResponse.outputTokens || 0;
            discoveryTokens = (summaryResponse.inputTokens || 0) + (summaryResponse.outputTokens || 0);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            discoveryTokens,
            originalTimestamp,
            'Anthropic',
            lastCwd
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Anthropic API agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Anthropic API agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude SDK
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Anthropic API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Anthropic API agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to Anthropic's messages format
   */
  private conversationToAnthropicMessages(history: ConversationMessage[]): AnthropicMessage[] {
    return history.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content
    }));
  }

  /**
   * Query Anthropic via REST API with full conversation history (multi-turn)
   */
  private async queryAnthropicMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: AnthropicModel
  ): Promise<{ content: string; inputTokens?: number; outputTokens?: number }> {
    const messages = this.conversationToAnthropicMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Anthropic API multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 4096,
        temperature: 0.3,  // Lower temperature for structured extraction
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as AnthropicResponse;

    if (!data.content?.[0]?.text) {
      logger.error('SDK', 'Empty response from Anthropic');
      return { content: '' };
    }

    const content = data.content.map(c => c.text).join('\n');
    const inputTokens = data.usage?.input_tokens;
    const outputTokens = data.usage?.output_tokens;

    return { content, inputTokens, outputTokens };
  }

  /**
   * Get Anthropic configuration from settings or environment
   */
  private getAnthropicConfig(): { apiKey: string; model: AnthropicModel } {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then environment variable
    const apiKey = settings.CLAUDE_MEM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';

    // Model: from CLAUDE_MEM_MODEL setting (used for both SDK and API modes)
    const defaultModel: AnthropicModel = 'claude-sonnet-4-5';
    const configuredModel = settings.CLAUDE_MEM_MODEL || defaultModel;
    const validModels: AnthropicModel[] = [
      'claude-sonnet-4-5',
      'claude-haiku-3-5',
      'claude-opus-4',
    ];

    let model: AnthropicModel;
    if (validModels.includes(configuredModel as AnthropicModel)) {
      model = configuredModel as AnthropicModel;
    } else {
      logger.warn('SDK', `Model "${configuredModel}" may not be available via API, using ${defaultModel}`, {
        configured: configuredModel,
        validModels,
      });
      model = defaultModel;
    }

    return { apiKey, model };
  }
}

/**
 * Check if Anthropic API is available (has API key configured)
 */
export function isAnthropicAPIAvailable(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * Check if Anthropic API is the selected provider
 */
export function isAnthropicAPISelected(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'anthropic-api';
}

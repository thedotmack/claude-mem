/**
 * OpenAIAgent: Direct OpenAI API observation extraction
 *
 * First-class OpenAI provider that calls the OpenAI API directly
 * (not through OpenRouter). Forked from OpenRouterAgent with
 * OpenRouter-specific headers and branding removed.
 *
 * Responsibility:
 * - Call OpenAI REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support model selection across OpenAI models
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
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

// OpenAI API endpoint (direct, not through OpenRouter)
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// Context window management constants
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string; type?: string };
}

export class OpenAIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const { apiKey, model } = this.getOpenAIConfig();
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Set CLAUDE_MEM_OPENAI_API_KEY in settings or OPENAI_API_KEY environment variable.');
      }

      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `openai-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenAI`);
      }

      const mode = ModeManager.getInstance().getActiveMode();
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryOpenAIMultiTurn(session.conversationHistory, apiKey, model);

      if (initResponse.content) {
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
        await processAgentResponse(initResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, null, 'OpenAI', undefined);
      }

      let lastCwd: string | undefined;
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);
        if (message.cwd) lastCwd = message.cwd;
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) session.lastPromptNumber = message.prompt_number;
          if (!session.memorySessionId) throw new Error('Cannot process observations: memorySessionId not yet captured.');

          const obsPrompt = buildObservationPrompt({
            id: 0, tool_name: message.tool_name!, tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response), created_at_epoch: originalTimestamp ?? Date.now(), cwd: message.cwd
          });
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryOpenAIMultiTurn(session.conversationHistory, apiKey, model);
          const tokensUsed = obsResponse.tokensUsed || 0;
          if (obsResponse.content) {
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }
          await processAgentResponse(obsResponse.content || '', session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'OpenAI', lastCwd);

        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) throw new Error('Cannot process summary: memorySessionId not yet captured.');
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId, memory_session_id: session.memorySessionId,
            project: session.project, user_prompt: session.userPrompt, last_assistant_message: message.last_assistant_message || ''
          }, mode);
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryOpenAIMultiTurn(session.conversationHistory, apiKey, model);
          const tokensUsed = summaryResponse.tokensUsed || 0;
          if (summaryResponse.content) {
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }
          await processAgentResponse(summaryResponse.content || '', session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'OpenAI', lastCwd);
        }
      }

      logger.success('SDK', 'OpenAI agent completed', { sessionId: session.sessionDbId, model });
    } catch (error: unknown) {
      if (isAbortError(error)) { logger.warn('SDK', 'OpenAI agent aborted'); throw error; }
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenAI API failed, falling back to Claude SDK', { error: error instanceof Error ? error.message : String(error) });
        return this.fallbackAgent.startSession(session, worker);
      }
      logger.failure('SDK', 'OpenAI agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private estimateTokens(text: string): number { return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE); }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;
    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) return history;
    }
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);
      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) break;
      truncated.unshift(msg);
      tokenCount += msgTokens;
    }
    return truncated;
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({ role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const, content: msg.content }));
  }

  private async queryOpenAIMultiTurn(history: ConversationMessage[], apiKey: string, model: string): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 4096 }),
    });
    if (!response.ok) { const errorText = await response.text(); throw new Error(`OpenAI API error: ${response.status} - ${errorText}`); }
    const data = await response.json() as OpenAIResponse;
    if (data.error) throw new Error(`OpenAI API error: ${data.error.type} - ${data.error.message}`);
    if (!data.choices?.[0]?.message?.content) return { content: '' };
    return { content: data.choices[0].message.content, tokensUsed: data.usage?.total_tokens };
  }

  private getOpenAIConfig(): { apiKey: string; model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return {
      apiKey: settings.CLAUDE_MEM_OPENAI_API_KEY || getCredential('OPENAI_API_KEY') || '',
      model: settings.CLAUDE_MEM_OPENAI_MODEL || 'gpt-4o-mini'
    };
  }
}

export function isOpenAIAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return !!(settings.CLAUDE_MEM_OPENAI_API_KEY || getCredential('OPENAI_API_KEY'));
}

export function isOpenAISelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'openai';
}

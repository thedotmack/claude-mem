import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef
} from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';

interface OllamaResponse {
  message?: {
    role: 'user' | 'assistant';
    content: string;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class OllamaSessionProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const { endpoint, model } = this.getOllamaConfig();

    if (!endpoint) {
      throw new Error('Ollama endpoint not configured. Set OLLAMA_ENDPOINT in settings (e.g., http://localhost:11434).');
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `ollama-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.success('SDK', `✓ OLLAMA ACTIVE | sessionDbId=${session.sessionDbId} | memorySessionId=${syntheticMemorySessionId}`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });
    let initResponse: { content: string; tokensUsed?: number };
    try {
      initResponse = await this.queryOllamaMultiTurn(session.conversationHistory, endpoint, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Ollama init query failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Ollama init query failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleOllamaError(error, session, worker);
    }

    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.6);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.4);
      await processAgentResponse(initResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, null, 'Ollama', undefined, model);
    } else {
      logger.error('SDK', 'Empty Ollama init response - session may lack context', { sessionId: session.sessionDbId, model });
    }

    try {
      await this.processMessageLoop(session, worker, endpoint, model, mode);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Ollama message loop failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Ollama message loop failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleOllamaError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Ollama agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length
    });
  }

  private async processMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    endpoint: string,
    model: string,
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
        await this.processObservationMessage(session, message, worker, endpoint, model, originalTimestamp, lastCwd);
      } else if (message.type === 'summarize') {
        await this.processSummaryMessage(session, message, worker, endpoint, model, mode, originalTimestamp, lastCwd);
      }
    }
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { type: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    worker: WorkerRef | undefined,
    endpoint: string,
    model: string,
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
    const obsResponse = await this.queryOllamaMultiTurn(session.conversationHistory, endpoint, model);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.6);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.4);
    }

    if (obsResponse.content) {
      await processAgentResponse(obsResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'Ollama', lastCwd, model);
    } else {
      logger.warn('SDK', 'Empty Ollama observation response, leaving queue intact', {
        sessionId: session.sessionDbId
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { type: string; last_assistant_message?: string },
    worker: WorkerRef | undefined,
    endpoint: string,
    model: string,
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
    const summaryResponse = await this.queryOllamaMultiTurn(session.conversationHistory, endpoint, model);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.6);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.4);
    }

    if (summaryResponse.content) {
      await processAgentResponse(summaryResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'Ollama', lastCwd, model);
    } else {
      logger.warn('SDK', 'Empty Ollama summary response, leaving queue intact', {
        sessionId: session.sessionDbId
      });
    }
  }

  private handleOllamaError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Ollama agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'Ollama agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private async queryOllamaMultiTurn(
    history: ConversationMessage[],
    endpoint: string,
    model: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const messages: OllamaMessage[] = history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    logger.debug('SDK', `Querying Ollama multi-turn (${model})`, {
      endpoint,
      turns: messages.length
    });

    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false
        })
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new ClassifiedProviderError(
          `Ollama API error: ${response.status} - ${errorBody}`,
          { kind: 'transient', cause: new Error(`HTTP ${response.status}`) }
        );
      }

      const data = (await response.json()) as OllamaResponse;

      if (!data.message?.content) {
        logger.error('SDK', 'Empty response from Ollama');
        return { content: '' };
      }

      const tokensUsed = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
      return { content: data.message.content, tokensUsed };
    } catch (error: unknown) {
      if (error instanceof ClassifiedProviderError) {
        throw error;
      }
      throw new ClassifiedProviderError(
        `Ollama connection failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: 'transient', cause: error }
      );
    }
  }

  private getOllamaConfig(): { endpoint: string; model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return {
      endpoint: settings.OLLAMA_ENDPOINT?.trim() || 'http://localhost:11434',
      model: settings.OLLAMA_MODEL?.trim() || 'gpt-oss:20b'
    };
  }
}

export function isOllamaSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  return settings.CLAUDE_MEM_PROVIDER === 'ollama';
}

export function isOllamaAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  return !!(settings.OLLAMA_ENDPOINT?.trim());
}

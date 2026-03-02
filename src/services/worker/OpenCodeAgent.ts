import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef,
} from './agents/index.js';

interface OpenCodeConfig {
  baseUrl: string;
}

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodeAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;
  private client: OpenCodeClient | null = null;
  private clientBaseUrl: string | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const config = this.getOpenCodeConfig();
      const client = this.getClient(config.baseUrl);
      const mode = ModeManager.getInstance().getActiveMode();

      const opencodeSessionId = await this.ensureOpenCodeSession(client, session);

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      await this.promptAndProcess(client, session, opencodeSessionId, initPrompt, worker, null, undefined);

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

          const observationPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name || 'unknown',
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd,
          });

          await this.promptAndProcess(
            client,
            session,
            opencodeSessionId,
            observationPrompt,
            worker,
            originalTimestamp,
            lastCwd,
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
            last_assistant_message: message.last_assistant_message || '',
          }, mode);

          await this.promptAndProcess(
            client,
            session,
            opencodeSessionId,
            summaryPrompt,
            worker,
            originalTimestamp,
            lastCwd,
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenCode agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
      });
    } catch (error) {
      if (isAbortError(error)) {
        logger.info('SDK', 'OpenCode session aborted by user', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenCode failed, falling back to Claude SDK', {
          sessionId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      throw error;
    }
  }

  private getClient(baseUrl: string): OpenCodeClient {
    if (!this.client || this.clientBaseUrl !== baseUrl) {
      this.client = createOpencodeClient({ baseUrl });
      this.clientBaseUrl = baseUrl;
    }
    return this.client;
  }

  private getOpenCodeConfig(): OpenCodeConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const baseUrl = settings.CLAUDE_MEM_OPENCODE_BASE_URL || 'http://127.0.0.1:4096';
    return { baseUrl };
  }

  private async ensureOpenCodeSession(client: OpenCodeClient, session: ActiveSession): Promise<string> {
    const existing = this.extractOpenCodeSessionId(session.memorySessionId);
    if (existing) {
      return existing;
    }

    const created = await client.session.create({
      body: {
        title: `claude-mem ${session.project}`,
      },
    });

    const createdSessionId = this.extractSessionId(created);
    if (!createdSessionId) {
      throw new Error('OpenCode session creation did not return a session id.');
    }

    const memorySessionId = `opencode-sdk:${createdSessionId}`;
    session.memorySessionId = memorySessionId;
    this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, memorySessionId);

    logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenCode`, {
      sessionId: session.sessionDbId,
      memorySessionId,
    });

    return createdSessionId;
  }

  private async promptAndProcess(
    client: OpenCodeClient,
    session: ActiveSession,
    opencodeSessionId: string,
    prompt: string,
    worker: WorkerRef | undefined,
    originalTimestamp: number | null,
    projectRoot?: string,
  ): Promise<void> {
    session.conversationHistory.push({ role: 'user', content: prompt });

    const response = await client.session.prompt({
      path: { id: opencodeSessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
      },
    });

    const responseText = this.extractResponseText(response);
    if (!responseText) {
      logger.warn('SDK', 'Empty OpenCode response, skipping processing to preserve message', {
        sessionId: session.sessionDbId,
      });
      return;
    }

    session.conversationHistory.push({ role: 'assistant', content: responseText });

    await processAgentResponse(
      responseText,
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      0,
      originalTimestamp,
      'OpenCode',
      projectRoot,
    );
  }

  private extractOpenCodeSessionId(memorySessionId: string | null): string | null {
    if (!memorySessionId) return null;
    if (!memorySessionId.startsWith('opencode-sdk:')) return null;
    const opencodeSessionId = memorySessionId.substring('opencode-sdk:'.length).trim();
    return opencodeSessionId.length > 0 ? opencodeSessionId : null;
  }

  private extractSessionId(response: unknown): string | null {
    const root = this.toRecord(response);
    const data = this.toRecord(root?.data);
    const fromData = this.pickString(data?.id);
    if (fromData) return fromData;
    return this.pickString(root?.id);
  }

  private extractResponseText(response: unknown): string {
    const root = this.toRecord(response);
    const data = this.toRecord(root?.data);

    const parts = Array.isArray(data?.parts)
      ? data.parts
      : (Array.isArray(root?.parts) ? root.parts : []);

    const textParts: string[] = [];
    for (const part of parts) {
      const record = this.toRecord(part);
      if (!record) continue;
      const maybeText = this.pickString(record.text);
      if (maybeText) {
        textParts.push(maybeText);
      }
    }

    if (textParts.length > 0) {
      return textParts.join('\n').trim();
    }

    const info = this.toRecord(data?.info);
    const fallbackText = this.pickString(info?.text);
    return fallbackText || '';
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private pickString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

export function isOpenCodeSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'opencode';
}

export function isOpenCodeAvailable(): boolean {
  return true;
}

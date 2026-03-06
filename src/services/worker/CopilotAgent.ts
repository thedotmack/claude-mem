/**
 * CopilotAgent: GitHub Copilot-based observation extraction
 *
 * Uses GitHub Copilot's OpenAI-compatible chat completions API.
 *
 * Token source:
 * - By default reads token from OpenClaw credentials file:
 *   ~/.openclaw/credentials/github-copilot.token.json
 *
 * IMPORTANT:
 * - Never log the token.
 * - If the token is missing/expired, instruct user to run:
 *   openclaw models auth login-github-copilot
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

const COPILOT_CHAT_COMPLETIONS_URL = 'https://api.githubcopilot.com/chat/completions';

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface CopilotResponse {
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

type CopilotTokenFile = {
  token?: string;
  expiresAt?: string | number;
};

function parseExpiresAt(expiresAt: string | number | undefined): number | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (typeof expiresAt === 'number') {
    // Heuristic: seconds vs ms
    return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  }
  const d = Date.parse(expiresAt);
  return Number.isFinite(d) ? d : null;
}

function readCopilotTokenFromFile(tokenFilePath: string): { token: string; expiresAtMs: number | null } {
  if (!existsSync(tokenFilePath)) {
    throw new Error(
      `GitHub Copilot token file not found at ${tokenFilePath}. ` +
      `If you use OpenClaw, generate it with: openclaw models auth login-github-copilot (TTY required).`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(tokenFilePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read GitHub Copilot token file at ${tokenFilePath}. ` +
      `If you use OpenClaw, regenerate it with: openclaw models auth login-github-copilot (TTY required).`
    );
  }

  let parsed: CopilotTokenFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GitHub Copilot token file at ${tokenFilePath} is not valid JSON. ` +
      `Regenerate it with: openclaw models auth login-github-copilot (TTY required).`
    );
  }

  const token = parsed.token;
  const expiresAtMs = parseExpiresAt(parsed.expiresAt);

  if (!token || typeof token !== 'string') {
    throw new Error(
      `GitHub Copilot token file at ${tokenFilePath} is missing a valid "token" field. ` +
      `Regenerate it with: openclaw models auth login-github-copilot (TTY required).`
    );
  }

  // Consider token expired if within 60 seconds of expiry
  if (expiresAtMs !== null && Date.now() > (expiresAtMs - 60_000)) {
    throw new Error(
      `GitHub Copilot token appears to be expired (expiresAt=${parsed.expiresAt}). ` +
      `Regenerate it with: openclaw models auth login-github-copilot (TTY required).`
    );
  }

  return { token, expiresAtMs };
}

export class CopilotAgent {
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
      const { token, model } = this.getCopilotConfig();

      // Generate synthetic memorySessionId (Copilot is stateless)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `github-copilot-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=GitHubCopilot`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryCopilotMultiTurn(session.conversationHistory, token, model);

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
          'GitHubCopilot',
          undefined
        );
      } else {
        logger.error('SDK', 'Empty Copilot init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);

        if (message.cwd) lastCwd = message.cwd;
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) session.lastPromptNumber = message.prompt_number;
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
          const obsResponse = await this.queryCopilotMultiTurn(session.conversationHistory, token, model);

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
            'GitHubCopilot',
            lastCwd
          );

        } else if (message.type === 'summarize') {
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
          const summaryResponse = await this.queryCopilotMultiTurn(session.conversationHistory, token, model);

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
            'GitHubCopilot',
            lastCwd
          );
        }
      }

      const durationMs = Date.now() - session.startTime;
      logger.success('SDK', 'Copilot agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(durationMs / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Copilot agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Copilot request failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Copilot agent error', { sessionDbId: session.sessionDbId }, error);
      throw error;
    }
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  }

  private async queryCopilotMultiTurn(history: ConversationMessage[], token: string, model: string): Promise<{ content: string; tokensUsed?: number }> {
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((acc, m) => acc + m.content.length, 0);

    logger.debug('SDK', `Querying GitHub Copilot multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    const resp = await fetch(COPILOT_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub Copilot API error: ${resp.status} - ${text}`);
    }

    const data = (await resp.json()) as CopilotResponse;
    if (data.error) {
      throw new Error(`GitHub Copilot API error: ${data.error.code} - ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.error('SDK', 'Empty response from GitHub Copilot');
      return { content: '' };
    }

    const tokensUsed = data.usage?.total_tokens;
    return { content, tokensUsed };
  }

  private getCopilotConfig(): { token: string; model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const model = settings.CLAUDE_MEM_COPILOT_MODEL || 'gpt-4.1';
    const tokenFile = settings.CLAUDE_MEM_COPILOT_TOKEN_FILE || join(homedir(), '.openclaw', 'credentials', 'github-copilot.token.json');

    const { token } = readCopilotTokenFromFile(tokenFile);
    return { token, model };
  }
}

export function isCopilotSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'github-copilot';
}

export function isCopilotAvailable(): boolean {
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const tokenFile = settings.CLAUDE_MEM_COPILOT_TOKEN_FILE || join(homedir(), '.openclaw', 'credentials', 'github-copilot.token.json');
    // Throws if missing/expired
    readCopilotTokenFromFile(tokenFile);
    return true;
  } catch (err) {
    // Don't spam logs; worker-service will log provider selection.
    return false;
  }
}

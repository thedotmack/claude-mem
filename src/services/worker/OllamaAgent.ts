/**
 * OllamaAgent: Local observation extraction via Ollama
 *
 * This agent replaces cloud/API providers (Claude/Gemini/OpenRouter) with a local model
 * served by Ollama (typically on http://127.0.0.1:11434).
 *
 * Note: Claude-Mem embeddings/vector search are handled separately via ChromaSync/Chroma-MCP.
 */

import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import {
  buildInitPrompt,
  buildObservationPrompt,
  buildSummaryPrompt,
  buildContinuationPrompt
} from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import type { WorkerRef, FallbackAgent } from './agents/types.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError
} from './agents/index.js';

type OllamaChatRole = 'user' | 'assistant';

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
  };
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
  error?: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Conservative token estimate for local accounting.
 * (This is ONLY used for ROI metrics; it does not affect cost.)
 */
function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

function convertHistoryToOllamaMessages(history: ConversationMessage[]): Array<{ role: OllamaChatRole; content: string }> {
  // Claude-mem stores conversation history as {role: 'user'|'assistant'} only.
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));
}

export class OllamaAgent {
  private fallbackAgent: FallbackAgent | null = null;

  constructor(
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager
  ) {}

  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const { baseUrl, model, temperature, maxContextMessages, maxTokens, fallbackToClaudeEnabled } = this.getOllamaConfig();

      // Ollama is stateful for chat context, but Claude-mem supplies full prompts anyway.
      // We still maintain synthetic memory_session_id for FK compliance.
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `ollama-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Ollama`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });

      const initResponseText = await this.queryOllamaChatMultiTurn(session.conversationHistory, {
        baseUrl,
        model,
        temperature,
        maxContextMessages,
        maxTokens
      });

      if (initResponseText) {
        const tokensUsed = estimateTokensFromText(initResponseText);
        await processAgentResponse(
          initResponseText,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Ollama'
        );
      } else {
        logger.error('SDK', 'Empty Ollama init response - session may lack context', {
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

          const obsResponseText = await this.queryOllamaChatMultiTurn(session.conversationHistory, {
            baseUrl,
            model,
            temperature,
            maxContextMessages,
            maxTokens
          });

          const tokensUsed = obsResponseText ? estimateTokensFromText(obsResponseText) : 0;

          await processAgentResponse(
            obsResponseText || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp ?? null,
            'Ollama',
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

          const summaryResponseText = await this.queryOllamaChatMultiTurn(session.conversationHistory, {
            baseUrl,
            model,
            temperature,
            maxContextMessages,
            maxTokens
          });

          const tokensUsed = summaryResponseText ? estimateTokensFromText(summaryResponseText) : 0;

          await processAgentResponse(
            summaryResponseText || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp ?? null,
            'Ollama',
            lastCwd
          );
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        logger.info('SDK', 'Ollama agent aborted by user', {}, error as Error);
        return;
      }

      logger.error('SDK', 'Ollama agent error', { sessionDbId: session.sessionDbId }, error as Error);

      // Optional: allow falling back to Claude SDK if explicitly enabled.
      const message = error instanceof Error ? error.message : String(error);
      if (this.fallbackAgent) {
        const { fallbackToClaudeEnabled } = this.getOllamaConfig();
        if (fallbackToClaudeEnabled && shouldFallbackToClaude(message)) {
          logger.warn('SDK', 'Ollama failed - falling back to Claude SDK', { sessionDbId: session.sessionDbId });
          return this.fallbackAgent.startSession(session, worker);
        }
      }

      throw error;
    }
  }

  private async queryOllamaChatMultiTurn(
    history: ConversationMessage[],
    cfg: { baseUrl: string; model: string; temperature: number; maxContextMessages: number; maxTokens: number }
  ): Promise<string> {
    const trimmed = this.trimConversation(history, cfg.maxContextMessages, cfg.maxTokens);
    const ollamaMessages = convertHistoryToOllamaMessages(trimmed);

    const url = `${trimTrailingSlash(cfg.baseUrl)}/api/chat`;
    logger.debug('SDK', `Querying Ollama multi-turn (${cfg.model})`, {
      turns: trimmed.length
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: ollamaMessages,
        stream: false,
        options: {
          temperature: cfg.temperature
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OllamaChatResponse;
    const content =
      data.message?.content ||
      data.choices?.[0]?.message?.content;

    return content || '';
  }

  private trimConversation(history: ConversationMessage[], maxContextMessages: number, maxTokens: number): ConversationMessage[] {
    // Keep the most recent messages first.
    const reversed = [...history].reverse();
    const kept: ConversationMessage[] = [];

    let usedTokens = 0;
    for (const msg of reversed) {
      const msgTokens = estimateTokensFromText(msg.content);
      if (kept.length >= maxContextMessages) break;
      if (usedTokens + msgTokens > maxTokens) break;

      kept.push(msg);
      usedTokens += msgTokens;
    }

    return kept.reverse();
  }

  private getOllamaConfig(): {
    baseUrl: string;
    model: string;
    temperature: number;
    maxContextMessages: number;
    maxTokens: number;
    fallbackToClaudeEnabled: boolean;
  } {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const baseUrl = settings.CLAUDE_MEM_OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const model = settings.CLAUDE_MEM_OLLAMA_MODEL || 'qwen2.5-coder:7b';

    const temperature = settings.CLAUDE_MEM_OLLAMA_TEMPERATURE
      ? parseFloat(settings.CLAUDE_MEM_OLLAMA_TEMPERATURE)
      : 0.2;
    const maxContextMessages = settings.CLAUDE_MEM_OLLAMA_MAX_CONTEXT_MESSAGES
      ? parseInt(settings.CLAUDE_MEM_OLLAMA_MAX_CONTEXT_MESSAGES, 10)
      : 20;
    const maxTokens = settings.CLAUDE_MEM_OLLAMA_MAX_TOKENS
      ? parseInt(settings.CLAUDE_MEM_OLLAMA_MAX_TOKENS, 10)
      : 100000;

    const fallbackToClaudeEnabled =
      String(settings.CLAUDE_MEM_OLLAMA_FALLBACK_TO_CLAUDE ?? '')
        .trim()
        .toLowerCase() === 'true';

    return {
      baseUrl,
      model,
      temperature: Number.isFinite(temperature) ? temperature : 0.2,
      maxContextMessages: Number.isFinite(maxContextMessages) ? maxContextMessages : 20,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 100000,
      fallbackToClaudeEnabled
    };
  }
}

/**
 * Check if Ollama is selected as provider.
 */
export function isOllamaSelected(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'ollama';
}

/** Last successful probe; updated by {@link isOllamaAvailable} for sync readers (e.g. /api/health). */
let ollamaReachabilityCached = false;

const OLLAMA_PROBE_CACHE_MS = 2000;
let ollamaProbeCache: { ok: boolean; at: number } | null = null;

/**
 * Build a validated http(s) URL for Ollama's tags endpoint (no shell / user-controlled injection).
 */
function resolveValidatedOllamaTagsUrl(baseUrlRaw: string): URL | null {
  try {
    const trimmed = trimTrailingSlash(baseUrlRaw.trim());
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return null;
    }
    const base = new URL(trimmed);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return null;
    }
    if (!base.hostname) {
      return null;
    }
    const tags = new URL('/api/tags', base);
    return tags;
  } catch {
    return null;
  }
}

async function probeOllamaTagsReachable(tagsUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(tagsUrl.href, {
      method: 'GET',
      signal: AbortSignal.timeout(1500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Cached reachability for synchronous health/status (e.g. getAiStatus) without blocking the event loop.
 */
export function getOllamaReachabilityCached(): boolean {
  return ollamaReachabilityCached;
}

/**
 * Check if Ollama is reachable (HTTP GET /api/tags on configured base URL).
 * Updates {@link getOllamaReachabilityCached} for sync consumers.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const baseUrl = settings.CLAUDE_MEM_OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

    const tagsUrl = resolveValidatedOllamaTagsUrl(baseUrl);
    if (!tagsUrl) {
      ollamaReachabilityCached = false;
      return false;
    }

    const now = Date.now();
    if (ollamaProbeCache && now - ollamaProbeCache.at < OLLAMA_PROBE_CACHE_MS) {
      ollamaReachabilityCached = ollamaProbeCache.ok;
      return ollamaProbeCache.ok;
    }

    const ok = await probeOllamaTagsReachable(tagsUrl);
    ollamaProbeCache = { ok, at: now };
    ollamaReachabilityCached = ok;
    return ok;
  } catch {
    ollamaReachabilityCached = false;
    return false;
  }
}


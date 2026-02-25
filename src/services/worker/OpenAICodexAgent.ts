/**
 * OpenAICodexAgent: OpenAI Codex (ChatGPT Plus/Pro OAuth) observation extraction
 *
 * Allows claude-mem to extract observations using a ChatGPT Plus/Pro subscription
 * via OAuth, without requiring an Anthropic API key or Claude Code context.
 *
 * This is the recommended provider for OpenClaw users, since Anthropic's ToS
 * prohibits using Claude OAuth tokens in third-party apps (as of Feb 2026).
 *
 * Credential discovery order:
 *   1. CLAUDE_MEM_OPENAI_CODEX_AGENT_DIR setting (explicit override)
 *   2. OPENCLAW_AGENT_DIR env var (set automatically by OpenClaw at runtime)
 *   3. ~/.openclaw/agents/default/agent/auth-profiles.json (OpenClaw default)
 *   4. ~/.claude-mem/auth-profiles.json (standalone fallback)
 *
 * Responsibility:
 * - Read OpenAI Codex OAuth credentials from auth-profiles.json
 * - Auto-refresh expired tokens via pi-ai's refreshOpenAICodexToken
 * - Call OpenAI Codex responses API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini/OpenRouter agents)
 * - Sync to database and Chroma
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import {
  buildInitPrompt,
  buildObservationPrompt,
  buildSummaryPrompt,
  buildContinuationPrompt,
} from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent,
} from './agents/index.js';

// OpenAI Codex OAuth endpoint (ChatGPT backend responses API)
const OPENAI_CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

// Codex responses require stream=true and store=false.
const CODEX_STREAM = true;
const CODEX_STORE = false;

// Codex endpoint currently requires explicit instructions.
const CODEX_INSTRUCTIONS =
  'You are Claude-Mem observation extraction assistant. Follow the prompt exactly and output only the requested content.';

// Default model for OpenAI Codex OAuth (GPT-5.x Codex series)
const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';

// Context window limits (same as OpenRouterAgent)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Auth profile store schema (subset — mirrors OpenClaw's auth-profiles.json)
interface AuthProfile {
  type: 'oauth' | 'api_key';
  provider: string;
  refresh?: string;
  access?: string;
  expires?: number;
  [key: string]: unknown;
}
interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfile>;
}

// Codex responses input format
interface CodexInputMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CodexStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    error?: { message?: string; code?: string };
  };
  error?: { message?: string; code?: string };
}

// ─────────────────────────────────────────────────────────────
// Token cache (process-lifetime, keyed by authDir)
// ─────────────────────────────────────────────────────────────

interface CachedToken {
  access: string;
  expires: number;  // epoch ms
}
const tokenCache = new Map<string, CachedToken>();

// ─────────────────────────────────────────────────────────────
// Credential helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the directory that contains auth-profiles.json.
 * Preference order: explicit setting → OPENCLAW_AGENT_DIR env → OpenClaw default → claude-mem fallback.
 */
function resolveAuthDir(): string {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (settings.CLAUDE_MEM_OPENAI_CODEX_AGENT_DIR) {
    return settings.CLAUDE_MEM_OPENAI_CODEX_AGENT_DIR;
  }
  if (process.env.OPENCLAW_AGENT_DIR) {
    return process.env.OPENCLAW_AGENT_DIR;
  }
  // OpenClaw default: ~/.openclaw/agents/default/agent
  const openclawDefault = join(homedir(), '.openclaw', 'agents', 'default', 'agent');
  if (existsSync(join(openclawDefault, 'auth-profiles.json'))) {
    return openclawDefault;
  }
  // Standalone fallback: ~/.claude-mem
  return join(homedir(), '.claude-mem');
}

/**
 * Load the auth-profiles.json store from the resolved auth directory.
 */
function loadAuthStore(authDir: string): AuthProfileStore | null {
  const path = join(authDir, 'auth-profiles.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AuthProfileStore;
  } catch {
    return null;
  }
}

/**
 * Find the first OpenAI Codex OAuth profile in the store.
 */
function findCodexProfile(store: AuthProfileStore): AuthProfile | null {
  for (const [id, profile] of Object.entries(store.profiles)) {
    if (id.startsWith('openai-codex:') && profile.type === 'oauth') {
      return profile;
    }
  }
  return null;
}

/**
 * Persist updated credentials back to auth-profiles.json.
 * Only updates the matching profile — leaves everything else untouched.
 */
function saveCodexProfile(authDir: string, store: AuthProfileStore, updated: AuthProfile): void {
  const filePath = join(authDir, 'auth-profiles.json');
  for (const [id, profile] of Object.entries(store.profiles)) {
    if (id.startsWith('openai-codex:') && profile.type === 'oauth') {
      store.profiles[id] = { ...profile, ...updated };
      break;
    }
  }
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Get a valid access token, refreshing it if expired.
 * Requires pi-ai to be installed as a dependency of claude-mem.
 */
async function getAccessToken(): Promise<string> {
  const authDir = resolveAuthDir();
  const bufferMs = 5 * 60 * 1000;

  // Fast path: in-memory cache (avoids disk read on every query)
  const cached = tokenCache.get(authDir);
  if (cached && Date.now() < (cached.expires - bufferMs)) {
    return cached.access;
  }

  // Load from disk to check / get refresh token
  const store = loadAuthStore(authDir);

  if (!store) {
    throw new Error(
      `OpenAI Codex OAuth: no auth-profiles.json found in ${authDir}.\n` +
      `Run 'openclaw auth' (or 'npx @mariozechner/pi-ai login openai-codex') to authenticate.`
    );
  }

  const profile = findCodexProfile(store);
  if (!profile || !profile.refresh) {
    throw new Error(
      `OpenAI Codex OAuth: no openai-codex profile found in ${authDir}/auth-profiles.json.\n` +
      `Run 'openclaw auth' to add OpenAI Codex authentication.`
    );
  }

  // Token on disk still valid — populate cache and return
  if (profile.access && profile.expires && Date.now() < (profile.expires - bufferMs)) {
    tokenCache.set(authDir, { access: profile.access, expires: profile.expires });
    return profile.access;
  }

  // Token expired — refresh it
  logger.info('SDK', 'OpenAI Codex token expired, refreshing…');
  try {
    // Dynamic import so claude-mem can work without pi-ai if provider is not 'openai-codex'
    // @ts-ignore — dynamic import; pi-ai must be a dependency of claude-mem
    const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai') as any;
    const refreshed = await refreshOpenAICodexToken(profile.refresh);
    saveCodexProfile(authDir, store, refreshed);
    // Update in-memory cache
    tokenCache.set(authDir, { access: refreshed.access, expires: refreshed.expires });
    logger.info('SDK', 'OpenAI Codex token refreshed successfully');
    return refreshed.access;
  } catch (err) {
    throw new Error(
      `OpenAI Codex OAuth: token refresh failed — ${err instanceof Error ? err.message : String(err)}.\n` +
      `Re-authenticate with 'openclaw auth'.`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Agent class
// ─────────────────────────────────────────────────────────────

export class OpenAICodexAgent {
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
      const model = this.getModel();

      // Generate synthetic memorySessionId (stateless REST API)
      if (!session.memorySessionId) {
        const id = `openai-codex-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = id;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, id);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenAICodex`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      // Init prompt
      const initPrompt =
        session.lastPromptNumber === 1
          ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
          : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.query(session.conversationHistory, model);

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
          'OpenAICodex',
          undefined
        );
      }

      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);
        if (message.cwd) lastCwd = message.cwd;
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }
          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not captured.');
          }

          const observationPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd,
          });

          session.conversationHistory.push({ role: 'user', content: observationPrompt });
          const obsResponse = await this.query(session.conversationHistory, model);

          const tokensUsed = obsResponse.tokensUsed || 0;
          session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
          session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAICodex',
            lastCwd
          );

        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not captured.');
          }

          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || '',
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const sumResponse = await this.query(session.conversationHistory, model);

          const tokensUsed = sumResponse.tokensUsed || 0;
          session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
          session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

          await processAgentResponse(
            sumResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAICodex',
            lastCwd
          );
        }
      }

      logger.success('SDK', 'OpenAI Codex agent completed', {
        sessionId: session.sessionDbId,
        model,
        duration: `${((Date.now() - session.startTime) / 1000).toFixed(1)}s`,
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'OpenAI Codex agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenAI Codex API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenAI Codex agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  // ── Private helpers ────────────────────────────────────────

  private getModel(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return settings.CLAUDE_MEM_OPENAI_CODEX_MODEL || DEFAULT_CODEX_MODEL;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    // Re-use OpenRouter context settings as general limits (same defaults apply)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const MAX_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;
    // Note: these settings will be renamed to CLAUDE_MEM_CONTEXT_MAX_* in a future refactor

    if (history.length <= MAX_MESSAGES) {
      const totalTokens = history.reduce((s, m) => s + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_TOKENS) return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const t = this.estimateTokens(msg.content);
      if (truncated.length >= MAX_MESSAGES || tokenCount + t > MAX_TOKENS) break;
      truncated.unshift(msg);
      tokenCount += t;
    }
    return truncated;
  }

  private toCodexInput(history: ConversationMessage[]): CodexInputMessage[] {
    return history.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
  }

  /**
   * Call OpenAI Codex responses endpoint with OAuth Bearer token.
   * Token is refreshed automatically if expired.
   */
  private async query(
    history: ConversationMessage[],
    model: string,
  ): Promise<{ content: string; tokensUsed?: number }> {
    const accessToken = await getAccessToken();
    const input = this.toCodexInput(this.truncateHistory(history));

    logger.debug('SDK', `Querying OpenAI Codex (${model})`, { turns: input.length });

    const response = await fetch(OPENAI_CODEX_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        instructions: CODEX_INSTRUCTIONS,
        input,
        stream: CODEX_STREAM,
        store: CODEX_STORE,
      }),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI Codex API error: ${response.status} — ${rawBody}`);
    }

    let accumulatedText = '';
    let completedText = '';
    let tokensUsed: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const lines = rawBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let event: CodexStreamEvent;
      try {
        event = JSON.parse(payload) as CodexStreamEvent;
      } catch {
        continue;
      }

      if (event.error?.message) {
        throw new Error(`OpenAI Codex API error: ${event.error.code ?? 'unknown'} — ${event.error.message}`);
      }

      switch (event.type) {
        case 'response.output_text.delta':
          if (typeof event.delta === 'string') {
            accumulatedText += event.delta;
          }
          break;
        case 'response.output_text.done':
          if (typeof event.text === 'string') {
            completedText = event.text;
          }
          break;
        case 'response.completed': {
          const usage = event.response?.usage;
          tokensUsed = usage?.total_tokens;
          inputTokens = usage?.input_tokens;
          outputTokens = usage?.output_tokens;

          const output = event.response?.output;
          if (Array.isArray(output)) {
            const parts: string[] = [];
            for (const item of output) {
              if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
              for (const part of item.content) {
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                  parts.push(part.text);
                }
              }
            }
            if (parts.length > 0) {
              completedText = parts.join('');
            }
          }

          if (event.response?.error?.message) {
            throw new Error(
              `OpenAI Codex API error: ${event.response.error.code ?? 'unknown'} — ${event.response.error.message}`,
            );
          }
          break;
        }
      }
    }

    const content = completedText || accumulatedText;
    if (!content) {
      logger.error('SDK', 'Empty response from OpenAI Codex');
      return { content: '' };
    }

    if (tokensUsed) {
      logger.info('SDK', 'OpenAI Codex API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
      });
    }

    return { content, tokensUsed };
  }
}

// ─────────────────────────────────────────────────────────────
// Provider detection helpers (mirrors OpenRouterAgent pattern)
// ─────────────────────────────────────────────────────────────

/** Returns true if a valid openai-codex OAuth profile exists on disk. */
export function isOpenAICodexAvailable(): boolean {
  const authDir = resolveAuthDir();
  const store = loadAuthStore(authDir);
  if (!store) return false;
  return !!findCodexProfile(store);
}

/** Returns true if CLAUDE_MEM_PROVIDER is set to 'openai-codex'. */
export function isOpenAICodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-codex';
}

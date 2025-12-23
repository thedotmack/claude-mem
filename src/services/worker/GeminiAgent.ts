/**
 * GeminiAgent: Gemini-based observation extraction
 *
 * Alternative to SDKAgent that uses Google's Gemini API directly
 * for extracting observations from tool usage.
 *
 * Responsibility:
 * - Call Gemini REST API for observation extraction
 * - Parse XML responses (same format as Claude)
 * - Sync to database and Chroma
 */

import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, PendingMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';

// Gemini API endpoint
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini model types
export type GeminiModel = 'gemini-2.0-flash-exp' | 'gemini-1.5-flash' | 'gemini-1.5-pro';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start Gemini agent for a session
   */
  async startSession(session: ActiveSession, worker?: any): Promise<void> {
    try {
      // Get Gemini configuration
      const { apiKey, model } = this.getGeminiConfig();

      if (!apiKey) {
        throw new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.claudeSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.claudeSessionId, mode);

      // Query Gemini with initial prompt
      const initResponse = await this.queryGemini(initPrompt, apiKey, model);

      if (initResponse.content) {
        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response
        await this.processGeminiResponse(session, initResponse.content, worker, tokensUsed);
      }

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
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
            created_at_epoch: Date.now(),
            cwd: message.cwd
          });

          // Query Gemini
          const obsResponse = await this.queryGemini(obsPrompt, apiKey, model);

          if (obsResponse.content) {
            const tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
            await this.processGeminiResponse(session, obsResponse.content, worker, tokensUsed);
          }

        } else if (message.type === 'summarize') {
          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            sdk_session_id: session.sdkSessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_user_message: message.last_user_message || '',
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Query Gemini
          const summaryResponse = await this.queryGemini(summaryPrompt, apiKey, model);

          if (summaryResponse.content) {
            const tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
            await this.processGeminiResponse(session, summaryResponse.content, worker, tokensUsed);
          }
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Gemini agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`
      });

      this.dbManager.getSessionStore().markSessionCompleted(session.sessionDbId);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error);
      }
      throw error;
    } finally {
      // Cleanup
      this.sessionManager.deleteSession(session.sessionDbId).catch(() => {});
    }
  }

  /**
   * Query Gemini via REST API
   */
  private async queryGemini(
    prompt: string,
    apiKey: string,
    model: GeminiModel
  ): Promise<{ content: string; tokensUsed?: number }> {
    logger.debug('SDK', `Querying Gemini (${model})`, { promptLength: prompt.length });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.3,  // Lower temperature for structured extraction
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as GeminiResponse;

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.warn('SDK', 'Empty response from Gemini');
      return { content: '' };
    }

    const content = data.candidates[0].content.parts[0].text;
    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return { content, tokensUsed };
  }

  /**
   * Process Gemini response (same format as Claude)
   */
  private async processGeminiResponse(
    session: ActiveSession,
    text: string,
    worker: any | undefined,
    discoveryTokens: number
  ): Promise<void> {
    // Parse observations (same XML format)
    const observations = parseObservations(text, session.claudeSessionId);

    // Store observations
    for (const obs of observations) {
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        discoveryTokens
      );

      logger.info('SDK', 'Gemini observation saved', {
        sessionId: session.sessionDbId,
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      });

      // Sync to Chroma
      this.dbManager.getChromaSync().syncObservation(
        obsId,
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).catch(err => {
        logger.warn('SDK', 'Gemini chroma sync failed', { obsId }, err);
      });

      // Broadcast to SSE clients
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_observation',
          observation: {
            id: obsId,
            sdk_session_id: session.sdkSessionId,
            session_id: session.claudeSessionId,
            type: obs.type,
            title: obs.title,
            subtitle: obs.subtitle,
            text: null,
            narrative: obs.narrative || null,
            facts: JSON.stringify(obs.facts || []),
            concepts: JSON.stringify(obs.concepts || []),
            files_read: JSON.stringify(obs.files_read || []),
            files_modified: JSON.stringify(obs.files_modified || []),
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }
    }

    // Parse summary
    const summary = parseSummary(text, session.sessionDbId);

    if (summary) {
      // Convert nullable fields to empty strings for storeSummary
      const summaryForStore = {
        request: summary.request || '',
        investigated: summary.investigated || '',
        learned: summary.learned || '',
        completed: summary.completed || '',
        next_steps: summary.next_steps || '',
        notes: summary.notes
      };

      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.claudeSessionId,
        session.project,
        summaryForStore,
        session.lastPromptNumber,
        discoveryTokens
      );

      logger.info('SDK', 'Gemini summary saved', {
        sessionId: session.sessionDbId,
        summaryId,
        request: summary.request || '(no request)'
      });

      // Sync to Chroma
      this.dbManager.getChromaSync().syncSummary(
        summaryId,
        session.claudeSessionId,
        session.project,
        summaryForStore,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).catch(err => {
        logger.warn('SDK', 'Gemini chroma sync failed', { summaryId }, err);
      });

      // Broadcast to SSE clients
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_summary',
          summary: {
            id: summaryId,
            session_id: session.claudeSessionId,
            request: summary.request,
            investigated: summary.investigated,
            learned: summary.learned,
            completed: summary.completed,
            next_steps: summary.next_steps,
            notes: summary.notes,
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }
    }

    // Mark messages as processed
    await this.markMessagesProcessed(session, worker);
  }

  /**
   * Mark pending messages as processed
   */
  private async markMessagesProcessed(session: ActiveSession, worker: any | undefined): Promise<void> {
    const pendingMessageStore = this.sessionManager.getPendingMessageStore();
    if (session.pendingProcessingIds.size > 0) {
      for (const messageId of session.pendingProcessingIds) {
        pendingMessageStore.markProcessed(messageId);
      }
      logger.debug('SDK', 'Gemini messages marked as processed', {
        sessionId: session.sessionDbId,
        count: session.pendingProcessingIds.size
      });
      session.pendingProcessingIds.clear();

      const deletedCount = pendingMessageStore.cleanupProcessed(100);
      if (deletedCount > 0) {
        logger.debug('SDK', 'Gemini cleaned up old processed messages', { deletedCount });
      }
    }

    if (worker && typeof worker.broadcastProcessingStatus === 'function') {
      worker.broadcastProcessingStatus();
    }
  }

  /**
   * Get Gemini configuration from settings or environment
   */
  private getGeminiConfig(): { apiKey: string; model: GeminiModel } {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then environment variable
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

    // Model: from settings or default
    const model = (settings.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.0-flash-exp') as GeminiModel;

    return { apiKey, model };
  }
}

/**
 * Check if Gemini is available (has API key configured)
 */
export function isGeminiAvailable(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * Check if Gemini is the selected provider
 */
export function isGeminiSelected(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}

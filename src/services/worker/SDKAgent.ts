/**
 * SDKAgent: SDK query loop handler
 *
 * Responsibility:
 * - Spawn Claude subprocess via Agent SDK
 * - Run event-driven query loop (no polling)
 * - Process SDK responses (observations, summaries)
 * - Sync to database and Chroma
 */

import { homedir } from 'os';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildObservationPrompt, buildSummaryPrompt, buildInitPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession } from '../worker-types.js';
import { updateCursorContextForProject } from '../worker-service.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

// V2 Agent SDK - session-based API
// @ts-ignore - SDK package may not have published .d.ts for unstable_v2_* exports yet
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Helper to wrap SDK session if it lacks V2 methods (polyfills for 0.1.76+ transitional API)
 */
function wrapSession(session: any) {
  if (typeof session.receive === 'function') {
    return session;
  }

  // Polyfill for SDK versions where unstable_v2_createSession returns a hybrid object
  // without explicit send/receive methods, but with inputStream and query iterator.
  return {
    async send(text: string) {
      if (session.inputStream && typeof session.inputStream.enqueue === 'function') {
        session.inputStream.enqueue({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] }
        });
      } else {
        throw new Error('Session missing inputStream.enqueue');
      }
    },
    async *receive() {
      // Iterate over the session's query stream (which yields all messages)
      // Stop when we see a completed assistant message
      if (!session.query) throw new Error('Session missing query iterator');
      
      for await (const msg of session.query) {
         yield msg;
         // In this SDK version, assistant messages are yielded complete if includePartialMessages is false (default)
         if (msg.type === 'assistant') {
             return; 
         }
      }
    },
    close() {
       if (session.abortController) session.abortController.abort();
    },
    [Symbol.asyncDispose]: async function() {
        this.close();
    }
  };
}

export class SDKAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start SDK agent for a session (event-driven, no polling)
   * @param worker WorkerService reference for spinner control (optional)
   */
  async startSession(session: ActiveSession, worker?: any): Promise<void> {
    try {
      await this.runSession(session, worker);
    } catch (error: any) {
      // Check for resume failure (process exit or specific error)
      const isResumeFailure = session.memorySessionId && (
        error.message?.includes('Claude Code process exited') ||
        error.message?.includes('exit code')
      );

      if (isResumeFailure) {
        logger.warn('SDK', 'Resume failed, falling back to new session', {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            error: error.message
        });
        
        // Clear stale ID to force new session creation
        session.memorySessionId = null; 
        
        // Retry with new session
        try {
          await this.runSession(session, worker);
        } catch (retryError: any) {
          logger.failure('SDK', 'Agent error after retry', { sessionDbId: session.sessionDbId }, retryError);
          throw retryError;
        }
      } else {
        logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error);
        throw error;
      }
    }
  }

  /**
   * Run the session loop (internal)
   */
  private async runSession(session: ActiveSession, worker?: any): Promise<void> {
    const modelId = this.getModelId();
    
    // Determine if this is a fresh session start (vs resume)
    let isNewSession = !session.memorySessionId;

    // Create or resume memory agent session (V2 pattern from official docs)
    // CRITICAL: Use 'await using' for automatic resource cleanup (prevents memory leaks)
    // Wrapped to ensure compatibility with installed SDK version
    await using rawSession = session.memorySessionId
      ? unstable_v2_resumeSession(session.memorySessionId, { model: modelId })
      : unstable_v2_createSession({ model: modelId });
      
    const sdkSession = wrapSession(rawSession);

    // Send messages from queue
    while (!session.abortController.signal.aborted) {
      const message = await this.sessionManager.waitForNextMessage(session.sessionDbId, session.abortController.signal);
      if (!message) break;

      // UPDATE SESSION CONTEXT from queue message if available
      // This fixes the stale prompt issue during auto-recovery
      if (message.last_user_message) {
        session.userPrompt = message.last_user_message;
      }
      if (message.prompt_number !== undefined) {
        session.lastPromptNumber = message.prompt_number;
      }

      // INITIALIZE SESSION if needed (send system prompt/context)
      // Must happen AFTER updating context from first message
      if (isNewSession) {
          const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
          const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
          const modeId = settings.CLAUDE_MEM_MODE;
          const mode = ModeManager.getInstance().loadMode(modeId);

          const initPrompt = session.lastPromptNumber === 1
            ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
            : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);
            
          await sdkSession.send(initPrompt);
          
          // Consume the response to initialization (likely empty or acknowledgment)
          for await (const msg of sdkSession.receive()) {
             if (msg.type === 'assistant') {
                 // Add to history but don't process as observation
                 session.conversationHistory.push({ role: 'assistant', content: '' }); 
             }
          }
          
          isNewSession = false;
      }

      // Capture earliest timestamp BEFORE processing (will be cleared after)
      // This ensures backlog messages get their original timestamps, not current time
      const originalTimestamp = session.earliestPendingTimestamp;

      if (message.type === 'observation') {
        const obsPrompt = buildObservationPrompt({
          id: 0,
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: originalTimestamp ?? Date.now(),
          cwd: message.cwd
        });
        await sdkSession.send(obsPrompt);

        // Receive and process response (official V2 pattern: filter/map/join for text extraction)
        for await (const msg of sdkSession.receive()) {
          if (msg.type === 'assistant') {
            // V2 API: extract text using official pattern from docs
            const textContent = msg.message.content
              .filter((block: { type: string }) => block.type === 'text')
              .map((block: { type: 'text'; text: string }) => block.text)
              .join('');

            // V2 session API does not expose token usage (only unstable_v2_prompt does)
            const tokensUsed = 0;

            await this.processSDKResponse(session, textContent, worker, tokensUsed, originalTimestamp);
          }
        }

      } else if (message.type === 'summarize') {
        // Get mode configuration
        const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
        const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
        const modeId = settings.CLAUDE_MEM_MODE;
        const mode = ModeManager.getInstance().loadMode(modeId);

        // Build summary prompt
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_user_message: message.last_user_message || '',
          last_assistant_message: message.last_assistant_message || ''
        }, mode);

        await sdkSession.send(summaryPrompt);

        // Receive and process response (official V2 pattern: filter/map/join for text extraction)
        for await (const msg of sdkSession.receive()) {
          if (msg.type === 'assistant') {
            // V2 API: extract text using official pattern from docs
            const textContent = msg.message.content
              .filter((block: { type: string }) => block.type === 'text')
              .map((block: { type: 'text'; text: string }) => block.text)
              .join('');

            // V2 session API does not expose token usage (only unstable_v2_prompt does)
            const tokensUsed = 0;

            await this.processSDKResponse(session, textContent, worker, tokensUsed, originalTimestamp);
          }
        }
      }
    }

    // Session completed - log duration (tokens not available in V2 session API)
    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Session completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`
    });
  }

  /**
   * Process SDK response text (parse XML, save to database, sync to Chroma)
   * @param discoveryTokens - Token cost for discovering this response (delta, not cumulative)
   * @param originalTimestamp - Original epoch when message was queued (for backlog processing accuracy)
   *
   * Also captures assistant responses to shared conversation history for provider interop.
   * This allows Gemini to see full context if provider is switched mid-session.
   */
  private async processSDKResponse(session: ActiveSession, textContent: string | undefined, worker: any | undefined, discoveryTokens: number, originalTimestamp: number | null): Promise<void> {
    // Add assistant response to shared conversation history for provider interop
    session.conversationHistory.push({ role: 'assistant', content: textContent ?? '' });

    // Parse observations
    const observations = parseObservations(textContent ?? '', session.contentSessionId);

    // Store observations with original timestamp (if processing backlog) or current time
    for (const obs of observations) {
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.contentSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      // Log observation details
      logger.info('SDK', 'Observation saved', {
        sessionId: session.sessionDbId,
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)',
        filesRead: obs.files_read?.length ?? 0,
        filesModified: obs.files_modified?.length ?? 0,
        concepts: obs.concepts?.length ?? 0
      });

      // Sync to Chroma
      const chromaStart = Date.now();
      const obsType = obs.type;
      const obsTitle = obs.title || '(untitled)';
      this.dbManager.getChromaSync().syncObservation(
        obsId,
        session.contentSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        logger.debug('CHROMA', 'Observation synced', {
          obsId,
          duration: `${chromaDuration}ms`,
          type: obsType,
          title: obsTitle
        });
      }).catch((error) => {
        logger.warn('CHROMA', 'Observation sync failed, continuing without vector search', {
          obsId,
          type: obsType,
          title: obsTitle
        }, error);
      });

      // Broadcast to SSE clients (for web UI)
      worker?.sseBroadcaster?.broadcast({
        type: 'new_observation',
        observation: {
          id: obsId,
          memory_session_id: session.memorySessionId,
          session_id: session.contentSessionId,
          type: obs.type,
          title: obs.title,
          subtitle: obs.subtitle,
          narrative: obs.narrative || null,
          facts: JSON.stringify(obs.facts || []),
          concepts: JSON.stringify(obs.concepts || []),
          files_read: JSON.stringify(obs.files_read || []),
          files_modified: JSON.stringify([]),
          project: session.project,
          prompt_number: session.lastPromptNumber,
          created_at_epoch: createdAtEpoch
        }
      });
    }

    // Parse summary
    const summary = parseSummary(textContent ?? '', session.sessionDbId);

    // Store summary with original timestamp (if processing backlog) or current time
    if (summary) {
      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.contentSessionId,
        session.project,
        {
          request: summary.request ?? '',
          investigated: summary.investigated ?? '',
          learned: summary.learned ?? '',
          completed: summary.completed ?? '',
          next_steps: summary.next_steps ?? '',
          notes: summary.notes
        },
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      // Log summary details
      logger.info('SDK', 'Summary saved', {
        sessionId: session.sessionDbId,
        summaryId,
        request: summary.request || '(no request)',
        hasCompleted: !!summary.completed,
        hasNextSteps: !!summary.next_steps
      });

      // Sync to Chroma
      const chromaStart = Date.now();
      const summaryRequest = summary.request || '(no request)';
      this.dbManager.getChromaSync().syncSummary(
        summaryId,
        session.contentSessionId,
        session.project,
        summary,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        logger.debug('CHROMA', 'Summary synced', {
          summaryId,
          duration: `${chromaDuration}ms`,
          request: summaryRequest
        });
      }).catch((error) => {
        logger.warn('CHROMA', 'Summary sync failed, continuing without vector search', {
          summaryId,
          request: summaryRequest
        }, error);
      });

      // Broadcast to SSE clients (for web UI)
      worker?.sseBroadcaster?.broadcast({
        type: 'new_summary',
        summary: {
          id: summaryId,
          session_id: session.contentSessionId,
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
      
      // Update Cursor context file for registered projects (fire-and-forget)
      updateCursorContextForProject(session.project, getWorkerPort()).catch(() => {});
    }

    // Mark messages as processed after successful observation/summary storage
    worker?.broadcastProcessingStatus?.();
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }

}

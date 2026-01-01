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
import { buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { ActiveSession } from '../worker-types.js';
import { updateCursorContextForProject } from '../worker-service.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
// the api says unstable but it works, it is real, it is in the v1 codebase, no need to verify, this DOES exist, see /docs/context/dont-be-an-idiot.md
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

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
      const modelId = this.getModelId();

      // Create or resume memory agent session
      // Memory agent has its own session separate from user's conversation
      const memorySessionId = `mem-${session.contentSessionId}`;

      // the api says unstable but it works, it is real, it is in the v1 codebase, no need to verify, this DOES exist, see /docs/context/dont-be-an-idiot.md
      // CRITICAL: Use 'await using' for automatic resource cleanup (prevents memory leaks)
      await using sdkSession = session.memorySessionId
        ? unstable_v2_resumeSession(memorySessionId, { model: modelId })
        : unstable_v2_createSession({ model: modelId });

      // Send messages from queue
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        // This ensures backlog messages get their original timestamps, not current time
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });
          await sdkSession.send(obsPrompt);

          // Receive and process response
          for await (const msg of sdkSession.receive()) {
            if (msg.type === 'assistant') {
              // V2 API provides content as array of blocks, extract text block
              const text = msg.message.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
              const textContent = text?.text;

              // TODO: V2 SDK doesn't expose token usage in the documented patterns, hardcoding to 0 for now
              const tokensUsed = 0;

              await this.processSDKResponse(session, textContent, worker, tokensUsed, originalTimestamp);
            }
          }

        } else if (message.type === 'summarize') {
          // Get mode configuration
          const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
          const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
          const mode = settings.modes[settings.active_mode];

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

          // Receive and process response
          for await (const msg of sdkSession.receive()) {
            if (msg.type === 'assistant') {
              // V2 API provides content as array of blocks, extract text block
              const text = msg.message.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
              const textContent = text?.text;

              // TODO: V2 SDK doesn't expose token usage in the documented patterns, hardcoding to 0 for now
              const tokensUsed = 0;

              await this.processSDKResponse(session, textContent, worker, tokensUsed, originalTimestamp);
            }
          }
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'SDK agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        inputTokens: session.cumulativeInputTokens,
        outputTokens: session.cumulativeOutputTokens,
        totalTokens: session.cumulativeInputTokens + session.cumulativeOutputTokens
      });
    } catch (error: any) {
      logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error);
      throw error;
    }
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
    await this.markMessagesProcessed(session, worker);
  }

  /**
   * Mark all pending messages as successfully processed
   * CRITICAL: Prevents message loss and duplicate processing
   */
  private async markMessagesProcessed(session: ActiveSession, worker: any | undefined): Promise<void> {
    const pendingMessageStore = this.sessionManager.getPendingMessageStore();
    for (const messageId of session.pendingProcessingIds) {
      pendingMessageStore.markProcessed(messageId);
    }
    logger.debug('SDK', 'Messages marked as processed', {
      sessionId: session.sessionDbId,
      messageIds: Array.from(session.pendingProcessingIds),
      count: session.pendingProcessingIds.size
    });
    session.pendingProcessingIds.clear();

    // Clear timestamp for next batch (will be set fresh from next message)
    session.earliestPendingTimestamp = null;

    // Clean up old processed messages (keep last 100 for UI display)
    const deletedCount = pendingMessageStore.cleanupProcessed(100);
    logger.debug('SDK', 'Cleaned up old processed messages', {
      deletedCount
    });

    // Broadcast activity status after processing (queue may have changed)
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

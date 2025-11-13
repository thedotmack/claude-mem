/**
 * SDKAgent: SDK query loop handler
 *
 * Responsibility:
 * - Spawn Claude subprocess via Agent SDK
 * - Run event-driven query loop (no polling)
 * - Process SDK responses (observations, summaries)
 * - Sync to database and Chroma
 */

import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { silentDebug } from '../../utils/silent-debug.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import type { ActiveSession, SDKUserMessage, PendingMessage } from '../worker-types.js';

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

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
      // Find Claude executable
      const claudePath = this.findClaudeExecutable();

      // Get model ID and disallowed tools
      const modelId = this.getModelId();
      const disallowedTools = ['Bash']; // Prevent infinite loops

      // Create message generator (event-driven)
      const messageGenerator = this.createMessageGenerator(session);

      // Run Agent SDK query loop
      const queryResult = query({
        prompt: messageGenerator,
        options: {
          model: modelId,
          disallowedTools,
          abortController: session.abortController,
          pathToClaudeCodeExecutable: claudePath
        }
      });

      // Process SDK messages
      for await (const message of queryResult) {
        // Handle assistant messages
        if (message.type === 'assistant') {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : typeof content === 'string' ? content : '';

          const responseSize = textContent.length;

          // Only log non-empty responses (filter out noise)
          if (responseSize > 0) {
            const truncatedResponse = responseSize > 100
              ? textContent.substring(0, 100) + '...'
              : textContent;
            logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
              sessionId: session.sessionDbId,
              promptNumber: session.lastPromptNumber
            }, truncatedResponse);

            // Parse and process response
            await this.processSDKResponse(session, textContent, worker);
          }
        }

        // Log result messages
        if (message.type === 'result' && message.subtype === 'success') {
          // Usage telemetry is captured at SDK level
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`
      });

      this.dbManager.getSessionStore().markSessionCompleted(session.sessionDbId);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'Agent aborted', { sessionId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error);
      }
      throw error;
    } finally {
      // Cleanup
      this.sessionManager.deleteSession(session.sessionDbId).catch(() => {});
    }
  }

  /**
   * Create event-driven message generator (yields messages from SessionManager)
   *
   * CRITICAL: CONTINUATION PROMPT LOGIC
   * ====================================
   * This is where NEW hook's dual-purpose nature comes together:
   *
   * - Prompt #1 (lastPromptNumber === 1): buildInitPrompt
   *   - Full initialization prompt with instructions
   *   - Sets up the SDK agent's context
   *
   * - Prompt #2+ (lastPromptNumber > 1): buildContinuationPrompt
   *   - Continuation prompt for same session
   *   - Includes session context and prompt number
   *
   * BOTH prompts receive session.claudeSessionId:
   * - This comes from the hook's session_id (see new-hook.ts)
   * - Same session_id used by SAVE hook to store observations
   * - This is how everything stays connected in one unified session
   *
   * NO SESSION EXISTENCE CHECKS NEEDED:
   * - SessionManager.initializeSession already fetched this from database
   * - Database row was created by new-hook's createSDKSession call
   * - We just use the session_id we're given - simple and reliable
   */
  private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
    // Yield initial user prompt with context (or continuation if prompt #2+)
    // CRITICAL: Both paths use session.claudeSessionId from the hook
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: session.lastPromptNumber === 1
          ? buildInitPrompt(session.project, session.claudeSessionId, session.userPrompt)
          : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.claudeSessionId)
      },
      session_id: session.claudeSessionId,
      parent_tool_use_id: null,
      isSynthetic: true
    };

    // Consume pending messages from SessionManager (event-driven, no polling)
    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      if (message.type === 'observation') {
        // Update last prompt number
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: buildObservationPrompt({
              id: 0, // Not used in prompt
              tool_name: message.tool_name!,
              tool_input: JSON.stringify(message.tool_input),
              tool_output: JSON.stringify(message.tool_response),
              created_at_epoch: Date.now(),
              cwd: message.cwd
            })
          },
          session_id: session.claudeSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      } else if (message.type === 'summarize') {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: buildSummaryPrompt({
              id: session.sessionDbId,
              sdk_session_id: session.sdkSessionId,
              project: session.project,
              user_prompt: session.userPrompt,
              last_user_message: message.last_user_message || '',
              last_assistant_message: message.last_assistant_message || ''
            })
          },
          session_id: session.claudeSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      }
    }
  }

  /**
   * Process SDK response text (parse XML, save to database, sync to Chroma)
   */
  private async processSDKResponse(session: ActiveSession, text: string, worker?: any): Promise<void> {
    // Parse observations
    const observations = parseObservations(text, session.claudeSessionId);

    // Store observations
    for (const obs of observations) {
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber
      );

      // Log observation details
      logger.info('SDK', 'Observation saved', {
        sessionId: session.sessionDbId,
        obsId,
        type: obs.type,
        title: obs.title || silentDebug('obs.title is null', { obsId, type: obs.type }, '(untitled)'),
        filesRead: obs.files_read?.length ?? silentDebug('obs.files_read is null/undefined', { obsId }, '0'),
        filesModified: obs.files_modified?.length ?? silentDebug('obs.files_modified is null/undefined', { obsId }, '0'),
        concepts: obs.concepts?.length ?? silentDebug('obs.concepts is null/undefined', { obsId }, '0')
      });

      // Sync to Chroma with error logging
      const chromaStart = Date.now();
      const obsType = obs.type;
      const obsTitle = obs.title || silentDebug('obs.title is null for Chroma sync', { obsId, type: obs.type }, '(untitled)');
      this.dbManager.getChromaSync().syncObservation(
        obsId,
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        createdAtEpoch
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        logger.debug('CHROMA', 'Observation synced', {
          obsId,
          duration: `${chromaDuration}ms`,
          type: obsType,
          title: obsTitle
        });
      }).catch(err => {
        logger.error('CHROMA', 'Failed to sync observation', {
          obsId,
          sessionId: session.sessionDbId,
          type: obsType,
          title: obsTitle
        }, err);
      });

      // Broadcast to SSE clients (for web UI)
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
            text: obs.text || null,
            narrative: obs.narrative || null,
            facts: JSON.stringify(obs.facts || []),
            concepts: JSON.stringify(obs.concepts || []),
            files_read: JSON.stringify(obs.files || []),
            files_modified: JSON.stringify([]),
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }
    }

    // Parse summary
    const summary = parseSummary(text, session.sessionDbId);

    // Store summary
    if (summary) {
      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.claudeSessionId,
        session.project,
        summary,
        session.lastPromptNumber
      );

      // Log summary details
      logger.info('SDK', 'Summary saved', {
        sessionId: session.sessionDbId,
        summaryId,
        request: summary.request || silentDebug('summary.request is null', { summaryId }, '(no request)'),
        hasCompleted: !!summary.completed,
        hasNextSteps: !!summary.next_steps
      });

      // Sync to Chroma with error logging
      const chromaStart = Date.now();
      const summaryRequest = summary.request || silentDebug('summary.request is null for Chroma sync', { summaryId }, '(no request)');
      this.dbManager.getChromaSync().syncSummary(
        summaryId,
        session.claudeSessionId,
        session.project,
        summary,
        session.lastPromptNumber,
        createdAtEpoch
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        logger.debug('CHROMA', 'Summary synced', {
          summaryId,
          duration: `${chromaDuration}ms`,
          request: summaryRequest
        });
      }).catch(err => {
        logger.error('CHROMA', 'Failed to sync summary', {
          summaryId,
          sessionId: session.sessionDbId,
          request: summaryRequest
        }, err);
      });

      // Broadcast to SSE clients (for web UI)
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

    // Broadcast activity status after processing (queue may have changed)
    if (worker && typeof worker.broadcastProcessingStatus === 'function') {
      worker.broadcastProcessingStatus();
    }
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Find Claude executable (inline, called once per session)
   */
  private findClaudeExecutable(): string {
    const claudePath = process.env.CLAUDE_CODE_PATH ||
      execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf8' })
        .trim().split('\n')[0].trim();

    if (!claudePath) {
      throw new Error('Claude executable not found in PATH');
    }

    return claudePath;
  }

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    try {
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const modelId = settings.env?.CLAUDE_MEM_MODEL;
        if (modelId) return modelId;
      }
    } catch {
      // Fall through to env var or default
    }

    return process.env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5';
  }
}

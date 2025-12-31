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
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, SDKUserMessage, PendingMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { pipelineMetrics } from '../pipeline/metrics.js';
import { updateCursorContextForProject } from '../worker-service.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

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
      // Memory agent is OBSERVER ONLY - no tools allowed
      const disallowedTools = [
        'Bash',           // Prevent infinite loops
        'Read',           // No file reading
        'Write',          // No file writing
        'Edit',           // No file editing
        'Grep',           // No code searching
        'Glob',           // No file pattern matching
        'WebFetch',       // No web fetching
        'WebSearch',      // No web searching
        'Task',           // No spawning sub-agents
        'NotebookEdit',   // No notebook editing
        'AskUserQuestion',// No asking questions
        'TodoWrite'       // No todo management
      ];

      // Create message generator (event-driven)
      const messageGenerator = this.createMessageGenerator(session);

      // CRITICAL: Only resume if memorySessionId is a REAL captured SDK session ID,
      // not the placeholder (which equals contentSessionId). The placeholder is set
      // for FK purposes but would cause the bug where we try to resume the USER's session!
      const hasRealMemorySessionId = session.memorySessionId &&
        session.memorySessionId !== session.contentSessionId;

      logger.info('SDK', 'Starting SDK query', {
        sessionDbId: session.sessionDbId,
        contentSessionId: session.contentSessionId,
        memorySessionId: session.memorySessionId,
        hasRealMemorySessionId,
        resume_parameter: hasRealMemorySessionId ? session.memorySessionId : '(none - fresh start)',
        lastPromptNumber: session.lastPromptNumber
      });

      // Run Agent SDK query loop
      // Only resume if we have a REAL captured memory session ID (not the placeholder)
      const queryResult = query({
        prompt: messageGenerator,
        options: {
          model: modelId,
          // Only resume if memorySessionId differs from contentSessionId (meaning it was captured)
          ...(hasRealMemorySessionId && { resume: session.memorySessionId }),
          disallowedTools,
          abortController: session.abortController,
          pathToClaudeCodeExecutable: claudePath
        }
      });

      // Process SDK messages
      for await (const message of queryResult) {
        // Capture memory session ID from first SDK message (any type has session_id)
        // This enables resume for subsequent generator starts within the same user session
        if (!session.memorySessionId && message.session_id) {
          session.memorySessionId = message.session_id;
          // Persist to database for cross-restart recovery
          this.dbManager.getSessionStore().updateMemorySessionId(
            session.sessionDbId,
            message.session_id
          );
          logger.info('SDK', 'Captured memory session ID', {
            sessionDbId: session.sessionDbId,
            memorySessionId: message.session_id
          });
        }

        // Handle assistant messages
        if (message.type === 'assistant') {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : typeof content === 'string' ? content : '';

          const responseSize = textContent.length;

          // Capture token state BEFORE updating (for delta calculation)
          const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;

          // Extract and track token usage
          const usage = message.message.usage;
          if (usage) {
            session.cumulativeInputTokens += usage.input_tokens || 0;
            session.cumulativeOutputTokens += usage.output_tokens || 0;

            // Cache creation counts as discovery, cache read doesn't
            if (usage.cache_creation_input_tokens) {
              session.cumulativeInputTokens += usage.cache_creation_input_tokens;
            }

            logger.debug('SDK', 'Token usage captured', {
              sessionId: session.sessionDbId,
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheCreation: usage.cache_creation_input_tokens || 0,
              cacheRead: usage.cache_read_input_tokens || 0,
              cumulativeInput: session.cumulativeInputTokens,
              cumulativeOutput: session.cumulativeOutputTokens
            });
          }

          // Calculate discovery tokens (delta for this response only)
          const discoveryTokens = (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse;

          // Process response (empty or not) and mark messages as processed
          // Capture earliest timestamp BEFORE processing (will be cleared after)
          const originalTimestamp = session.earliestPendingTimestamp;

          if (responseSize > 0) {
            const truncatedResponse = responseSize > 100
              ? textContent.substring(0, 100) + '...'
              : textContent;
            logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
              sessionId: session.sessionDbId,
              promptNumber: session.lastPromptNumber
            }, truncatedResponse);

            // Parse and process response with discovery token delta and original timestamp
            await this.processSDKResponse(session, textContent, worker, discoveryTokens, originalTimestamp);
          } else {
            // Empty response - still need to mark pending messages as processed
            await this.markMessagesProcessed(session, worker);
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

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('SDK', 'Agent aborted', { sessionId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      // NOTE: Do NOT delete session here - SessionRoutes.finally() handles cleanup
      // and auto-restart logic. Deleting here races with pending work checks.
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
   * BOTH prompts receive session.contentSessionId:
   * - This comes from the hook's session_id (see new-hook.ts)
   * - Same session_id used by SAVE hook to store observations
   * - This is how everything stays connected in one unified session
   *
   * NO SESSION EXISTENCE CHECKS NEEDED:
   * - SessionManager.initializeSession already fetched this from database
   * - Database row was created by new-hook's createSDKSession call
   * - We just use the session_id we're given - simple and reliable
   *
   * SHARED CONVERSATION HISTORY:
   * - Each user message is added to session.conversationHistory
   * - This allows provider switching (Claude→Gemini) with full context
   * - SDK manages its own internal state, but we mirror it for interop
   */
  private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
    // Load active mode
    const mode = ModeManager.getInstance().getActiveMode();

    // Build initial prompt
    const isInitPrompt = session.lastPromptNumber === 1;
    logger.info('SDK', 'Creating message generator', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      lastPromptNumber: session.lastPromptNumber,
      isInitPrompt,
      promptType: isInitPrompt ? 'INIT' : 'CONTINUATION'
    });

    const initPrompt = isInitPrompt
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    // Add to shared conversation history for provider interop
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    // Yield initial user prompt with context (or continuation if prompt #2+)
    // CRITICAL: Both paths use session.contentSessionId from the hook
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: initPrompt
      },
      session_id: session.contentSessionId,
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

        const obsPrompt = buildObservationPrompt({
          id: 0, // Not used in prompt
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: Date.now(),
          cwd: message.cwd
        });

        // Add to shared conversation history for provider interop
        session.conversationHistory.push({ role: 'user', content: obsPrompt });

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: obsPrompt
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      } else if (message.type === 'summarize') {
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_user_message: message.last_user_message || '',
          last_assistant_message: message.last_assistant_message || ''
        }, mode);

        // Add to shared conversation history for provider interop
        session.conversationHistory.push({ role: 'user', content: summaryPrompt });

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: summaryPrompt
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      }
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
  private async processSDKResponse(session: ActiveSession, text: string, worker: any | undefined, discoveryTokens: number, originalTimestamp: number | null): Promise<void> {
    // Add assistant response to shared conversation history for provider interop
    if (text) {
      session.conversationHistory.push({ role: 'assistant', content: text });
    }

    // Parse observations (with metrics)
    const parseStart = Date.now();
    const observations = parseObservations(text, session.contentSessionId);
    pipelineMetrics.recordStage('parse', Date.now() - parseStart, true, {
      observationCount: observations.length,
      textLength: text.length
    });

    // Store observations with original timestamp (if processing backlog) or current time
    for (const obs of observations) {
      // Store observation (with metrics)
      const renderStart = Date.now();
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.contentSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );
      pipelineMetrics.recordStage('render', Date.now() - renderStart, true, {
        obsId,
        type: obs.type
      });

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

      // Sync to Chroma (with metrics)
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
        pipelineMetrics.recordStage('chroma', chromaDuration, true, { obsId, type: obsType });
        logger.debug('CHROMA', 'Observation synced', {
          obsId,
          duration: `${chromaDuration}ms`,
          type: obsType,
          title: obsTitle
        });
      }).catch((error) => {
        pipelineMetrics.recordStage('chroma', Date.now() - chromaStart, false, { obsId, type: obsType });
        logger.warn('CHROMA', 'Observation sync failed, continuing without vector search', {
          obsId,
          type: obsType,
          title: obsTitle
        }, error);
      });

      // Calculate and store surprise score (Phase 2: Titans concepts)
      this.calculateAndStoreSurpriseScore(obsId, session);

      // Broadcast to SSE clients (for web UI) with metrics
      if (worker && worker.sseBroadcaster) {
        const broadcastStart = Date.now();
        try {
          worker.sseBroadcaster.broadcast({
            type: 'new_observation',
            observation: {
              id: obsId,
              memory_session_id: session.memorySessionId,
              session_id: session.contentSessionId,
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
          pipelineMetrics.recordStage('broadcast', Date.now() - broadcastStart, true, {
            obsId,
            type: 'observation'
          });
        } catch (error) {
          pipelineMetrics.recordStage('broadcast', Date.now() - broadcastStart, false, {
            obsId,
            type: 'observation',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // Parse summary
    const summary = parseSummary(text, session.sessionDbId);

    // Store summary with original timestamp (if processing backlog) or current time
    if (summary) {
      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.contentSessionId,
        session.project,
        summary,
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
        pipelineMetrics.recordStage('chroma', chromaDuration, true, { summaryId, type: 'summary' });
        logger.debug('CHROMA', 'Summary synced', {
          summaryId,
          duration: `${chromaDuration}ms`,
          request: summaryRequest
        });
      }).catch((error) => {
        pipelineMetrics.recordStage('chroma', Date.now() - chromaStart, false, { summaryId, type: 'summary' });
        logger.warn('CHROMA', 'Summary sync failed, continuing without vector search', {
          summaryId,
          request: summaryRequest
        }, error);
      });

      // Broadcast to SSE clients (for web UI) with metrics
      if (worker && worker.sseBroadcaster) {
        const broadcastStart = Date.now();
        try {
          worker.sseBroadcaster.broadcast({
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
          pipelineMetrics.recordStage('broadcast', Date.now() - broadcastStart, true, {
            summaryId,
            type: 'summary'
          });
        } catch (error) {
          pipelineMetrics.recordStage('broadcast', Date.now() - broadcastStart, false, {
            summaryId,
            type: 'summary',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      // Update Cursor context file for registered projects (fire-and-forget)
      updateCursorContextForProject(session.project, getWorkerPort()).catch(() => {});
    }

    // Mark messages as processed after successful observation/summary storage
    await this.markMessagesProcessed(session, worker);
  }

  /**
   * Calculate and store surprise score for an observation (Phase 2: Titans concepts)
   * This runs AFTER the observation is saved to always preserve data
   */
  private async calculateAndStoreSurpriseScore(obsId: number, session: ActiveSession): Promise<void> {
    const surpriseStart = Date.now();
    try {
      // Get settings
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

      // Skip if surprise filtering is disabled
      if (!settings.CLAUDE_MEM_SURPRISE_ENABLED) {
        return;
      }

      // Import dynamically to avoid circular dependencies
      const { SurpriseMetric } = await import('./SurpriseMetric.js');
      const { getMomentumBuffer } = await import('./MomentumBuffer.js');

      const db = this.dbManager.getSessionStore().db;
      const surpriseMetric = new SurpriseMetric(db);
      const momentumBuffer = getMomentumBuffer();

      // Get the observation
      const obs = this.dbManager.getSessionStore().getObservationById(obsId);
      if (!obs) return;

      // Calculate surprise (with fallback to fast method if Chroma fails)
      const result = await surpriseMetric.calculateWithFallback(obs, {
        lookbackDays: settings.CLAUDE_MEM_SURPRISE_LOOKBACK_DAYS,
        sampleSize: 50,
      });

      // Update importance score WITH the calculated surprise score
      const { ImportanceScorer } = await import('./ImportanceScorer.js');
      const importanceScorer = new ImportanceScorer(db);
      await importanceScorer.updateScore(obsId, {
        surpriseScore: result.score,
      });

      // Record success metrics
      pipelineMetrics.recordStage('surprise', Date.now() - surpriseStart, true, {
        obsId,
        score: result.score,
        method: result.method
      });

      // If high surprise, boost related topics (momentum)
      if (result.score > settings.CLAUDE_MEM_SURPRISE_THRESHOLD && settings.CLAUDE_MEM_MOMENTUM_ENABLED) {
        const topics = momentumBuffer.extractTopics(obs.title || obs.text || '', 10);
        momentumBuffer.boostFromMemory(
          topics,
          obsId,
          { duration: settings.CLAUDE_MEM_MOMENTUM_DURATION_MINUTES }
        );

        logger.debug('SDK', 'High surprise detected, topics boosted', {
          obsId,
          surprise: result.score,
          topics,
        });
      }
    } catch (error) {
      // Record failure metrics
      pipelineMetrics.recordStage('surprise', Date.now() - surpriseStart, false, {
        obsId,
        error: error instanceof Error ? error.message : String(error)
      });
      // Don't fail the observation save if surprise calculation fails
      logger.debug('SDK', 'Surprise calculation failed (non-fatal)', { obsId }, error as Error);
    }
  }

  /**
   * Mark all pending messages as successfully processed
   * CRITICAL: Prevents message loss and duplicate processing
   */
  private async markMessagesProcessed(session: ActiveSession, worker: any | undefined): Promise<void> {
    const pendingMessageStore = this.sessionManager.getPendingMessageStore();
    if (session.pendingProcessingIds.size > 0) {
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
      if (deletedCount > 0) {
        logger.debug('SDK', 'Cleaned up old processed messages', {
          deletedCount
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
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    
    // 1. Check configured path
    if (settings.CLAUDE_CODE_PATH) {
      // Lazy load fs to keep startup fast
      const { existsSync } = require('fs');
      if (!existsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_CODE_PATH;
    }

    // 2. Try auto-detection
    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude', 
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim().split('\n')[0].trim();
      
      if (claudePath) return claudePath;
    } catch (error) {
      logger.debug('SDK', 'Claude executable auto-detection failed', error);
    }

    throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
  }

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }
}

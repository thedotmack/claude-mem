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
import type { ActiveSession } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { updateCursorContextForProject } from '../worker-service.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

// Agent SDK V2 imports
// @ts-ignore - Agent SDK types
import { unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk';

interface SDKMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: any;
    usage?: any;
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
   * Start SDK agent for a session using V2 send/receive pattern
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

      // CRITICAL: Only resume if memorySessionId is a REAL captured SDK session ID,
      // not the placeholder (which equals contentSessionId). The placeholder is set
      // for FK purposes but would cause the bug where we try to resume the USER's session!
      const hasRealMemorySessionId = session.memorySessionId &&
        session.memorySessionId !== session.contentSessionId;

      logger.info('SDK', 'Starting SDK V2 session', {
        sessionDbId: session.sessionDbId,
        contentSessionId: session.contentSessionId,
        memorySessionId: session.memorySessionId,
        hasRealMemorySessionId,
        resume_parameter: hasRealMemorySessionId ? session.memorySessionId : '(none - fresh start)',
        lastPromptNumber: session.lastPromptNumber
      });

      // V2: Create or resume session with await using for automatic cleanup
      // This solves Issue #499 - orphaned processes are cleaned up automatically
      const sdkSessionOptions = {
        model: modelId,
        disallowedTools,
        pathToClaudeCodeExecutable: claudePath
      };

      await using sdkSession = hasRealMemorySessionId
        ? unstable_v2_resumeSession(session.memorySessionId!, sdkSessionOptions)
        : unstable_v2_createSession(sdkSessionOptions);

      // Load active mode and build initial prompt
      const mode = ModeManager.getInstance().getActiveMode();
      const isInitPrompt = session.lastPromptNumber === 1;

      const initPrompt = isInitPrompt
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to shared conversation history for provider interop
      session.conversationHistory.push({ role: 'user', content: initPrompt });

      // V2: Send initial prompt
      await sdkSession.send(initPrompt);

      // V2: Receive and process initial response
      for await (const message of sdkSession.receive()) {
        await this.handleSDKMessage(message, session, worker);
      }

      // Process pending messages from queue using V2 send/receive pattern
      for await (const pendingMsg of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        const originalTimestamp = session.earliestPendingTimestamp;

        // Build prompt based on message type
        let prompt: string;
        if (pendingMsg.type === 'observation') {
          // Update last prompt number
          if (pendingMsg.prompt_number !== undefined) {
            session.lastPromptNumber = pendingMsg.prompt_number;
          }

          prompt = buildObservationPrompt({
            id: 0, // Not used in prompt
            tool_name: pendingMsg.tool_name!,
            tool_input: JSON.stringify(pendingMsg.tool_input),
            tool_output: JSON.stringify(pendingMsg.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: pendingMsg.cwd
          });
        } else if (pendingMsg.type === 'summarize') {
          prompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_user_message: pendingMsg.last_user_message || '',
            last_assistant_message: pendingMsg.last_assistant_message || ''
          }, mode);
        } else {
          continue; // Unknown message type
        }

        // Add to shared conversation history for provider interop
        session.conversationHistory.push({ role: 'user', content: prompt });

        // V2: Send and receive for this message
        await sdkSession.send(prompt);
        for await (const message of sdkSession.receive()) {
          await this.handleSDKMessage(message, session, worker, originalTimestamp);
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`
      });

      // Note: Session cleanup is automatic via await using

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'Agent aborted', { sessionId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error);
      }
      throw error;
    }
    // Note: No finally block needed - await using handles cleanup automatically
  }

  /**
   * Handle a single SDK message (V2 pattern)
   * Extracts text, tracks tokens, and processes observations/summaries
   */
  private async handleSDKMessage(
    message: SDKMessage,
    session: ActiveSession,
    worker?: any,
    originalTimestamp?: number | null
  ): Promise<void> {
    // Validate message structure
    if (!message?.type) {
      logger.failure('SDK', 'Invalid message structure: missing type', {
        sessionId: session.sessionDbId
      }, new Error('Message type is required'));
      return;
    }
    // Capture session ID from system/init message (V2 pattern)
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      if (!session.memorySessionId || session.memorySessionId === session.contentSessionId) {
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
    }

    // Handle assistant messages
    if (message.type === 'assistant' && message.message?.content) {
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

      if (responseSize > 0) {
        const truncatedResponse = responseSize > 100
          ? textContent.substring(0, 100) + '...'
          : textContent;
        logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
          sessionId: session.sessionDbId,
          promptNumber: session.lastPromptNumber
        }, truncatedResponse);

        // Parse and process response with discovery token delta and original timestamp
        await this.processSDKResponse(session, textContent, worker, discoveryTokens, originalTimestamp ?? null);
      } else {
        // Empty response - still need to mark pending messages as processed
        await this.markMessagesProcessed(session, worker);
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

    // Parse observations
    const observations = parseObservations(text, session.contentSessionId);

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

      // Broadcast and sync observation
      await this.broadcastAndSyncDiscovery(
        obsId,
        'observation',
        session,
        obs,
        worker,
        createdAtEpoch,
        discoveryTokens
      );
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

      // Broadcast and sync summary
      await this.broadcastAndSyncDiscovery(
        summaryId,
        'summary',
        session,
        summary,
        worker,
        createdAtEpoch,
        discoveryTokens
      );

      // Update Cursor context file for registered projects (fire-and-forget)
      updateCursorContextForProject(session.project, getWorkerPort()).catch(() => {});
    }

    // Mark messages as processed after successful observation/summary storage
    await this.markMessagesProcessed(session, worker);
  }

  /**
   * Broadcast and sync a discovery (observation or summary) to Chroma and SSE
   * Consolidates the duplicate broadcast/sync logic for observations and summaries
   */
  private async broadcastAndSyncDiscovery(
    discoveryId: number,
    discoveryType: 'observation' | 'summary',
    session: ActiveSession,
    discoveryData: any,
    worker: any | undefined,
    createdAtEpoch: number,
    discoveryTokens: number
  ): Promise<void> {
    // 1. Sync to Chroma with circuit breaker
    if (session.chromaAvailable !== false) {
      const chromaStart = Date.now();
      const displayInfo = discoveryType === 'observation'
        ? { type: discoveryData.type, title: discoveryData.title || '(untitled)' }
        : { request: discoveryData.request || '(no request)' };

      const syncPromise = discoveryType === 'observation'
        ? this.dbManager.getChromaSync().syncObservation(
            discoveryId,
            session.contentSessionId,
            session.project,
            discoveryData,
            session.lastPromptNumber,
            createdAtEpoch,
            discoveryTokens
          )
        : this.dbManager.getChromaSync().syncSummary(
            discoveryId,
            session.contentSessionId,
            session.project,
            discoveryData,
            session.lastPromptNumber,
            createdAtEpoch,
            discoveryTokens
          );

      syncPromise.then(() => {
        const chromaDuration = Date.now() - chromaStart;
        logger.debug('CHROMA', `${discoveryType === 'observation' ? 'Observation' : 'Summary'} synced`, {
          [discoveryType === 'observation' ? 'obsId' : 'summaryId']: discoveryId,
          duration: `${chromaDuration}ms`,
          ...displayInfo
        });
      }).catch((error) => {
        logger.failure('CHROMA', `${discoveryType === 'observation' ? 'Observation' : 'Summary'} sync failed`, {
          [discoveryType === 'observation' ? 'obsId' : 'summaryId']: discoveryId,
          sessionId: session.sessionDbId
        }, error);
        session.chromaAvailable = false; // Circuit breaker
      });
    } else {
      logger.debug('CHROMA', `Skipping ${discoveryType} sync - service marked unavailable`, {
        sessionId: session.sessionDbId
      });
    }

    // 2. Broadcast to SSE with error handling
    if (worker && worker.sseBroadcaster) {
      try {
        const broadcastPayload = discoveryType === 'observation'
          ? {
              type: 'new_observation',
              observation: {
                id: discoveryId,
                memory_session_id: session.memorySessionId,
                session_id: session.contentSessionId,
                type: discoveryData.type,
                title: discoveryData.title,
                subtitle: discoveryData.subtitle,
                text: discoveryData.text || null,
                narrative: discoveryData.narrative || null,
                facts: JSON.stringify(discoveryData.facts || []),
                concepts: JSON.stringify(discoveryData.concepts || []),
                files_read: JSON.stringify(discoveryData.files_read || []),
                files_modified: JSON.stringify([]),
                project: session.project,
                prompt_number: session.lastPromptNumber,
                created_at_epoch: createdAtEpoch
              }
            }
          : {
              type: 'new_summary',
              summary: {
                id: discoveryId,
                session_id: session.contentSessionId,
                request: discoveryData.request,
                investigated: discoveryData.investigated,
                learned: discoveryData.learned,
                completed: discoveryData.completed,
                next_steps: discoveryData.next_steps,
                notes: discoveryData.notes,
                project: session.project,
                prompt_number: session.lastPromptNumber,
                created_at_epoch: createdAtEpoch
              }
            };

        worker.sseBroadcaster.broadcast(broadcastPayload);
      } catch (broadcastError) {
        logger.warn('SSE', `Failed to broadcast ${discoveryType} to UI`, {
          sessionId: session.sessionDbId,
          [discoveryType === 'observation' ? 'obsId' : 'summaryId']: discoveryId,
          ...(discoveryType === 'observation' ? { type: discoveryData.type } : {})
        }, broadcastError);
      }
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

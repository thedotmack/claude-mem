/**
 * SessionManager: Event-driven session lifecycle
 *
 * Responsibility:
 * - Manage active session lifecycle
 * - Handle event-driven message queues
 * - Coordinate between HTTP requests and SDK agent
 * - Zero-latency event notification (no polling)
 */

import { EventEmitter } from 'events';
import { DatabaseManager } from './DatabaseManager.js';
import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';

// Debug log entry for tracking agent lifecycle
interface DebugLogEntry {
  timestamp: number;
  event: string;
  sessionId?: number;
  details: Record<string, unknown>;
}

export class SessionManager {
  private dbManager: DatabaseManager;
  private pendingMessageStore: PendingMessageStore;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;

  // Debug log ring buffer - keeps last 100 events
  private debugLog: DebugLogEntry[] = [];
  private static readonly DEBUG_LOG_MAX = 100;

  constructor(dbManager: DatabaseManager, pendingMessageStore?: PendingMessageStore) {
    this.dbManager = dbManager;
    // PendingMessageStore is optional for backward compatibility during initialization
    // It will be set via setPendingMessageStore() after DB is ready
    this.pendingMessageStore = pendingMessageStore!;
  }

  /**
   * Set the PendingMessageStore (called after DB initialization)
   */
  setPendingMessageStore(store: PendingMessageStore): void {
    this.pendingMessageStore = store;
  }

  /**
   * Set callback to be called when a session is deleted (for broadcasting status)
   */
  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  /**
   * Add entry to debug log (ring buffer)
   */
  addDebugLog(event: string, sessionId?: number, details: Record<string, unknown> = {}): void {
    const entry: DebugLogEntry = {
      timestamp: Date.now(),
      event,
      sessionId,
      details
    };
    this.debugLog.push(entry);
    // Keep only last N entries
    if (this.debugLog.length > SessionManager.DEBUG_LOG_MAX) {
      this.debugLog.shift();
    }
  }

  /**
   * Get debug log entries (for API endpoint)
   */
  getDebugLog(): DebugLogEntry[] {
    return [...this.debugLog];
  }

  /**
   * Initialize a new session or return existing one
   */
  initializeSession(sessionDbId: number, currentUserPrompt?: string, promptNumber?: number): ActiveSession {
    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      // Refresh project from database in case it was updated by new-hook
      // This fixes the bug where sessions created with empty project get updated
      // in the database but the in-memory session still has the stale empty value
      const dbSession = this.dbManager.getSessionById(sessionDbId);
      if (dbSession.project && dbSession.project !== session.project) {
        logger.debug('SESSION', 'Updating project from database', {
          sessionDbId,
          oldProject: session.project,
          newProject: dbSession.project
        });
        session.project = dbSession.project;
      }

      // Update userPrompt for continuation prompts
      if (currentUserPrompt) {
        logger.debug('SESSION', 'Updating userPrompt for continuation', {
          sessionDbId,
          promptNumber,
          oldPrompt: session.userPrompt.substring(0, 80),
          newPrompt: currentUserPrompt.substring(0, 80)
        });
        session.userPrompt = currentUserPrompt;
        session.lastPromptNumber = promptNumber || session.lastPromptNumber;
      } else {
        logger.debug('SESSION', 'No currentUserPrompt provided for existing session', {
          sessionDbId,
          promptNumber,
          usingCachedPrompt: session.userPrompt.substring(0, 80)
        });
      }
      return session;
    }

    // Fetch from database
    const dbSession = this.dbManager.getSessionById(sessionDbId);

    // Use currentUserPrompt if provided, otherwise fall back to database (first prompt)
    const userPrompt = currentUserPrompt || dbSession.user_prompt;

    if (!currentUserPrompt) {
      logger.debug('SESSION', 'No currentUserPrompt provided for new session, using database', {
        sessionDbId,
        promptNumber,
        dbPrompt: dbSession.user_prompt.substring(0, 80)
      });
    } else {
      logger.debug('SESSION', 'Initializing session with fresh userPrompt', {
        sessionDbId,
        promptNumber,
        userPrompt: currentUserPrompt.substring(0, 80)
      });
    }

    // Create active session
    session = {
      sessionDbId,
      claudeSessionId: dbSession.claude_session_id,
      sdkSessionId: null,
      project: dbSession.project,
      userPrompt,
      pendingMessages: [],  // Deprecated: now using persistent store
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptCounter(sessionDbId),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      currentProcessingMessageId: null,
      currentProcessingOriginalTimestamp: null,
      pendingProcessingIds: new Set<number>()
    };

    this.sessions.set(sessionDbId, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      claudeSessionId: session.claudeSessionId,
      queueDepth: 0,
      hasGenerator: false
    });

    return session;
  }

  /**
   * Get active session by ID
   */
  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  /**
   * Queue an observation for processing (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   * PERSIST-FIRST: Message is written to DB before notification
   */
  queueObservation(sessionDbId: number, data: ObservationData): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd
    };

    // PERSIST FIRST - message survives crashes
    const messageId = this.pendingMessageStore.enqueue(
      sessionDbId,
      session.claudeSessionId,
      message
    );

    const queueDepth = this.pendingMessageStore.getPendingCount(sessionDbId);

    // Notify generator immediately (zero latency)
    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    // Format tool name for logging
    const toolSummary = logger.formatTool(data.tool_name, data.tool_input);

    logger.info('SESSION', `Observation persisted and queued (depth: ${queueDepth})`, {
      sessionId: sessionDbId,
      messageId,
      tool: toolSummary,
      hasGenerator: !!session.generatorPromise
    });
  }

  /**
   * Queue a summarize request (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   * PERSIST-FIRST: Message is written to DB before notification
   */
  queueSummarize(sessionDbId: number, lastUserMessage: string, lastAssistantMessage?: string): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'summarize',
      last_user_message: lastUserMessage,
      last_assistant_message: lastAssistantMessage
    };

    // PERSIST FIRST - message survives crashes
    const messageId = this.pendingMessageStore.enqueue(
      sessionDbId,
      session.claudeSessionId,
      message
    );

    const queueDepth = this.pendingMessageStore.getPendingCount(sessionDbId);

    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    logger.info('SESSION', `Summarize persisted and queued (depth: ${queueDepth})`, {
      sessionId: sessionDbId,
      messageId,
      hasGenerator: !!session.generatorPromise
    });
  }

  /**
   * Delete a session (abort SDK agent and cleanup)
   */
  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return; // Already deleted
    }

    const sessionDuration = Date.now() - session.startTime;

    // Abort the SDK agent
    session.abortController.abort();

    // Wait for generator to finish
    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {});
    }

    // Cleanup
    this.sessions.delete(sessionDbId);
    this.sessionQueues.delete(sessionDbId);

    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project
    });

    // Trigger callback to broadcast status update (spinner may need to stop)
    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  /**
   * Shutdown all active sessions
   */
  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  /**
   * Check if any session has pending messages (for spinner tracking)
   * Now uses persistent store instead of in-memory array
   */
  hasPendingMessages(): boolean {
    return this.pendingMessageStore?.hasAnyPendingWork() ?? false;
  }

  /**
   * Get number of active sessions (for stats)
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get diagnostic info for all active sessions
   * Used by queue UI to show which sessions have active agents
   */
  getSessionDiagnostics(): Map<number, { hasActiveAgent: boolean; startTime: number }> {
    const diagnostics = new Map<number, { hasActiveAgent: boolean; startTime: number }>();
    for (const [sessionDbId, session] of this.sessions.entries()) {
      diagnostics.set(sessionDbId, {
        hasActiveAgent: session.generatorPromise !== null,
        startTime: session.startTime
      });
    }
    return diagnostics;
  }

  /**
   * Force restart a session - aborts current agent and resets processing messages to pending
   * Used when a session is stuck and needs manual intervention
   */
  async forceRestartSession(sessionDbId: number): Promise<{ success: boolean; messagesReset: number }> {
    const session = this.sessions.get(sessionDbId);

    // Reset all processing messages for this session to pending
    const messagesReset = this.pendingMessageStore?.resetProcessingToPending(sessionDbId) ?? 0;

    if (session) {
      // Abort the current SDK agent
      session.abortController.abort();

      // Wait for generator to finish
      if (session.generatorPromise) {
        await session.generatorPromise.catch(() => {});
      }

      // Create fresh abort controller
      session.abortController = new AbortController();
      session.generatorPromise = null;
    }

    return { success: true, messagesReset };
  }

  /**
   * Get total queue depth across all sessions (for activity indicator)
   * Now uses persistent store instead of in-memory array
   */
  getTotalQueueDepth(): number {
    if (!this.pendingMessageStore) return 0;
    let total = 0;
    for (const session of this.sessions.values()) {
      total += this.pendingMessageStore.getPendingCount(session.sessionDbId);
    }
    return total;
  }

  /**
   * Get total active work (queued + currently processing)
   * Counts both pending messages and items actively being processed by SDK agents
   * Now uses persistent store instead of in-memory array
   */
  getTotalActiveWork(): number {
    if (!this.pendingMessageStore) return 0;
    let total = 0;
    for (const session of this.sessions.values()) {
      // Count queued messages from persistent store
      total += this.pendingMessageStore.getPendingCount(session.sessionDbId);
      // Count currently processing item (1 per active generator)
      if (session.generatorPromise !== null) {
        total += 1;
      }
    }
    return total;
  }

  /**
   * Check if any session is actively processing (has pending messages OR active generator)
   * Used for activity indicator to prevent spinner from stopping while SDK is processing
   * Now uses persistent store instead of in-memory array
   */
  isAnySessionProcessing(): boolean {
    // Check persistent store for any pending work
    if (this.pendingMessageStore?.hasAnyPendingWork()) {
      return true;
    }
    // Check for active generators
    for (const session of this.sessions.values()) {
      if (session.generatorPromise !== null) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get message iterator for SDKAgent to consume (event-driven, no polling)
   * Auto-initializes session if not in memory but exists in database
   * NOW READS FROM PERSISTENT STORE - messages include _persistentId for completion tracking
   */
  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    // Linger timeout: how long to wait for new messages before exiting
    // This keeps the agent alive between messages, reducing "No active agent" windows
    const LINGER_TIMEOUT_MS = 5000; // 5 seconds

    while (!session.abortController.signal.aborted) {
      // Check for pending messages in persistent store
      const persistentMessage = this.pendingMessageStore.peekPending(sessionDbId);

      if (!persistentMessage) {
        // Wait for new messages with timeout
        const gotMessage = await new Promise<boolean>(resolve => {
          let resolved = false;

          const messageHandler = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              resolve(true);
            }
          };

          const timeoutHandler = () => {
            if (!resolved) {
              resolved = true;
              emitter.off('message', messageHandler);
              resolve(false);
            }
          };

          const timeoutId = setTimeout(timeoutHandler, LINGER_TIMEOUT_MS);

          emitter.once('message', messageHandler);

          // Also listen for abort
          session.abortController.signal.addEventListener('abort', () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              emitter.off('message', messageHandler);
              resolve(false);
            }
          }, { once: true });
        });

        // Re-check for messages after waking up (handles race condition)
        const recheckMessage = this.pendingMessageStore.peekPending(sessionDbId);
        if (recheckMessage) {
          // Got a message, continue processing
          continue;
        }

        if (!gotMessage) {
          // Timeout or abort - exit the loop
          logger.info('SESSION', `Generator exiting after linger timeout`, { sessionId: sessionDbId });
          return;
        }

        continue;
      }

      // Mark as processing BEFORE yielding (status: pending -> processing)
      this.pendingMessageStore.markProcessing(persistentMessage.id);

      // Convert to PendingMessageWithId and yield
      // Include original timestamp for accurate observation timestamps (survives stuck processing)
      const message: PendingMessageWithId = {
        _persistentId: persistentMessage.id,
        _originalTimestamp: persistentMessage.created_at_epoch,
        ...this.pendingMessageStore.toPendingMessage(persistentMessage)
      };

      yield message;

      // If we just yielded a summary, that's the end of this batch - stop the iterator
      if (message.type === 'summarize') {
        logger.info('SESSION', `Summary yielded - ending generator`, { sessionId: sessionDbId });
        return;
      }
    }
  }

  /**
   * Get the PendingMessageStore (for watchdog and recovery)
   */
  getPendingMessageStore(): PendingMessageStore {
    return this.pendingMessageStore;
  }
}

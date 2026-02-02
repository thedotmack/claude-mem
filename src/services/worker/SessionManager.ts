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
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';
import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { SessionQueueProcessor } from '../queue/SessionQueueProcessor.js';
import { getProcessBySession, ensureProcessExit } from './ProcessRegistry.js';

// Stateless provider identifiers for synthetic ID generation
export const STATELESS_PROVIDERS = {
  GEMINI: 'gemini',
  OPENROUTER: 'openrouter'
} as const;

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;
  private pendingStore: PendingMessageStore | null = null;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get or create PendingMessageStore (lazy initialization to avoid circular dependency)
   */
  private getPendingStore(): PendingMessageStore {
    if (!this.pendingStore) {
      const sessionStore = this.dbManager.getSessionStore();
      this.pendingStore = new PendingMessageStore(sessionStore.db, 3);
    }
    return this.pendingStore;
  }

  /**
   * Set callback to be called when a session is deleted (for broadcasting status)
   */
  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  /**
   * Check if a memory_session_id is synthetic (from Gemini/OpenRouter) vs SDK UUID
   * Synthetic ID pattern: provider prefix + dash + contentSessionId (UUID) + dash + randomUUID
   * Examples: gemini-75919a84-1ce3-478f-b36c-91b637310fce-550e8400-e29b-41d4-a716-446655440000
   *           openrouter-75919a84-1ce3-478f-b36c-91b637310fce-660e8400-e29b-41d4-a716-446655440000
   * Both contentSessionId and randomUUID must be valid UUID format
   */
  private isSyntheticMemorySessionId(memorySessionId: string): boolean {
    // Strict pattern: provider-(UUID)-(UUID)
    const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const providers = Object.values(STATELESS_PROVIDERS).join('|');
    const syntheticPattern = new RegExp(`^(${providers})-(${uuidPattern})-(${uuidPattern})$`, 'i');
    return syntheticPattern.test(memorySessionId);
  }

  /**
   * Initialize a new session or return existing one
   */
  initializeSession(sessionDbId: number, currentUserPrompt?: string, promptNumber?: number): ActiveSession {
    logger.debug('SESSION', 'initializeSession called', {
      sessionDbId,
      promptNumber,
      has_currentUserPrompt: !!currentUserPrompt
    });

    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      logger.debug('SESSION', 'Returning cached session', {
        sessionDbId,
        contentSessionId: session.contentSessionId,
        lastPromptNumber: session.lastPromptNumber
      });

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

    logger.debug('SESSION', 'Fetched session from database', {
      sessionDbId,
      content_session_id: dbSession.content_session_id,
      memory_session_id: dbSession.memory_session_id
    });

    // Handle memory_session_id on restart (Issue #817)
    // Treat empty string as null for consistency
    if (dbSession.memory_session_id && dbSession.memory_session_id.trim() !== '') {
      const isSyntheticId = this.isSyntheticMemorySessionId(dbSession.memory_session_id);

      if (isSyntheticId) {
        // Preserve synthetic IDs - stateless providers have no server context to lose
        logger.debug('SESSION', `Preserving synthetic memory_session_id across restart`, {
          sessionDbId,
          syntheticMemorySessionId: dbSession.memory_session_id,
          reason: 'Stateless provider - no server-side state to lose'
        });
        // Will be loaded into session.memorySessionId in the session object creation below
      } else {
        // Discard SDK UUIDs - SDK context is lost on restart
        logger.warn('SESSION', `Discarding stale SDK memory_session_id from previous worker instance (Issue #817)`, {
          sessionDbId,
          staleMemorySessionId: dbSession.memory_session_id,
          reason: 'SDK context lost on worker restart - will capture new ID'
        });
        dbSession.memory_session_id = null; // Clear for SDK sessions
      }
    }

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
    // CRITICAL: Conditional memorySessionId loading (Issue #817)
    // - Synthetic IDs (openrouter-*, gemini-*): PRESERVE from database
    //   Stateless providers have no server context to lose on restart
    // - SDK UUIDs: DISCARD (set to null)
    //   SDK conversation context is lost when worker restarts
    // SDK will capture new ID on first response; stateless providers already generated theirs
    session = {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: (dbSession.memory_session_id && dbSession.memory_session_id.trim() !== '') ? dbSession.memory_session_id : null,  // Preserve synthetic IDs, null for SDK/empty
      project: dbSession.project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],  // Initialize empty - will be populated by agents
      currentProvider: null  // Will be set when generator starts
    };

    logger.debug('SESSION', 'Creating new session object (synthetic IDs preserved, SDK UUIDs discarded)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: session.memorySessionId || '(will be generated or captured)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id)
    });

    this.sessions.set(sessionDbId, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    // Log session initialization with synthetic ID info
    const logData: any = {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
      queueDepth: 0,
      hasGenerator: false
    };

    if (session.memorySessionId) {
      logData.memorySessionId = session.memorySessionId;
      logData.isSynthetic = this.isSyntheticMemorySessionId(session.memorySessionId);
    }

    logger.info('SESSION', 'Session initialized', logData);

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
   *
   * CRITICAL: Persists to database FIRST before adding to in-memory queue.
   * This ensures observations survive worker crashes.
   */
  queueObservation(sessionDbId: number, data: ObservationData): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    // CRITICAL: Persist to database FIRST
    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd
    };

    try {
      const messageId = this.getPendingStore().enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = this.getPendingStore().getPendingCount(sessionDbId);
      const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } catch (error) {
      logger.error('SESSION', 'Failed to persist observation to DB', {
        sessionId: sessionDbId,
        tool: data.tool_name
      }, error);
      throw error; // Don't continue if we can't persist
    }

    // Notify generator immediately (zero latency)
    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');
  }

  /**
   * Queue a summarize request (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   *
   * CRITICAL: Persists to database FIRST before adding to in-memory queue.
   * This ensures summarize requests survive worker crashes.
   */
  queueSummarize(sessionDbId: number, lastAssistantMessage?: string): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    // CRITICAL: Persist to database FIRST
    const message: PendingMessage = {
      type: 'summarize',
      last_assistant_message: lastAssistantMessage
    };

    try {
      const messageId = this.getPendingStore().enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = this.getPendingStore().getPendingCount(sessionDbId);
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=summarize | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } catch (error) {
      logger.error('SESSION', 'Failed to persist summarize to DB', {
        sessionId: sessionDbId
      }, error);
      throw error; // Don't continue if we can't persist
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');
  }

  /**
   * Delete a session (abort SDK agent and cleanup)
   * Verifies subprocess exit to prevent zombie process accumulation (Issue #737)
   */
  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return; // Already deleted
    }

    const sessionDuration = Date.now() - session.startTime;

    // 1. Abort the SDK agent
    session.abortController.abort();

    // 2. Wait for generator to finish
    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {
        logger.debug('SYSTEM', 'Generator already failed, cleaning up', { sessionId: session.sessionDbId });
      });
    }

    // 3. Verify subprocess exit with 5s timeout (Issue #737 fix)
    const tracked = getProcessBySession(sessionDbId);
    if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
      logger.debug('SESSION', `Waiting for subprocess PID ${tracked.pid} to exit`, {
        sessionId: sessionDbId,
        pid: tracked.pid
      });
      await ensureProcessExit(tracked, 5000);
    }

    // 4. Cleanup
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
   */
  hasPendingMessages(): boolean {
    return this.getPendingStore().hasAnyPendingWork();
  }

  /**
   * Get number of active sessions (for stats)
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get total queue depth across all sessions (for activity indicator)
   */
  getTotalQueueDepth(): number {
    let total = 0;
    // We can iterate over active sessions to get their pending count
    for (const session of this.sessions.values()) {
      total += this.getPendingStore().getPendingCount(session.sessionDbId);
    }
    return total;
  }

  /**
   * Get total active work (queued + currently processing)
   * Counts both pending messages and items actively being processed by SDK agents
   */
  getTotalActiveWork(): number {
    // getPendingCount includes 'processing' status, so this IS the total active work
    return this.getTotalQueueDepth();
  }

  /**
   * Check if any session is actively processing (has pending messages OR active generator)
   * Used for activity indicator to prevent spinner from stopping while SDK is processing
   */
  isAnySessionProcessing(): boolean {
    // hasAnyPendingWork checks for 'pending' OR 'processing'
    return this.getPendingStore().hasAnyPendingWork();
  }

  /**
   * Get message iterator for SDKAgent to consume (event-driven, no polling)
   * Auto-initializes session if not in memory but exists in database
   *
   * CRITICAL: Uses PendingMessageStore for crash-safe message persistence.
   * Messages are marked as 'processing' when yielded and must be marked 'processed'
   * by the SDK agent after successful completion.
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

    const processor = new SessionQueueProcessor(this.getPendingStore(), emitter);

    // Use the robust iterator - messages are deleted on claim (no tracking needed)
    for await (const message of processor.createIterator(sessionDbId, session.abortController.signal)) {
      // Track earliest timestamp for accurate observation timestamps
      // This ensures backlog messages get their original timestamps, not current time
      if (session.earliestPendingTimestamp === null) {
        session.earliestPendingTimestamp = message._originalTimestamp;
      } else {
        session.earliestPendingTimestamp = Math.min(session.earliestPendingTimestamp, message._originalTimestamp);
      }

      yield message;
    }
  }

  /**
   * Get the PendingMessageStore (for SDKAgent to mark messages as processed)
   */
  getPendingMessageStore(): PendingMessageStore {
    return this.getPendingStore();
  }
}

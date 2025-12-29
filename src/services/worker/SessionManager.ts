/**
 * SessionManager: Event-driven session lifecycle
 *
 * Responsibility:
 * - Manage active session lifecycle
 * - Handle event-driven message queues
 * - Coordinate between HTTP requests and SDK agent
 * - Zero-latency event notification (no polling)
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession } from '../worker-types.js';
import { SimpleQueue, type EnqueuePayload } from '../queue/index.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private onSessionDeletedCallback?: () => void;
  private simpleQueue: SimpleQueue | null = null;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get or create SimpleQueue (lazy initialization)
   */
  getSimpleQueue(): SimpleQueue {
    if (!this.simpleQueue) {
      const sessionStore = this.dbManager.getSessionStore();
      this.simpleQueue = new SimpleQueue(sessionStore.db);
    }
    return this.simpleQueue;
  }

  /**
   * Enqueue a message using the new SimpleQueue system
   * This is the replacement for queueObservation/queueSummarize
   */
  enqueueMessage(sessionDbId: number, claudeSessionId: string, payload: EnqueuePayload): number {
    const messageId = this.getSimpleQueue().enqueue(sessionDbId, claudeSessionId, payload);

    logger.info('SESSION', `Message enqueued via SimpleQueue`, {
      sessionId: sessionDbId,
      messageId,
      type: payload.type,
      tool: payload.tool_name
    });

    return messageId;
  }

  /**
   * Set callback to be called when a session is deleted (for broadcasting status)
   */
  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  /**
   * Initialize a new session or return existing one
   */
  initializeSession(sessionDbId: number, currentUserPrompt?: string, promptNumber?: number): ActiveSession {
    logger.info('SESSION', 'initializeSession called', {
      sessionDbId,
      promptNumber,
      has_currentUserPrompt: !!currentUserPrompt
    });

    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      logger.info('SESSION', 'Returning cached session', {
        sessionDbId,
        claudeSessionId: session.claudeSessionId,
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

    logger.info('SESSION', 'Fetched session from database', {
      sessionDbId,
      claude_session_id: dbSession.claude_session_id,
      sdk_session_id: dbSession.sdk_session_id
    });

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
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.claude_session_id),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      earliestPendingTimestamp: null,
      conversationHistory: [],  // Initialize empty - will be populated by agents
      currentProvider: null  // Will be set when generator starts
    };

    logger.info('SESSION', 'Creating new session object', {
      sessionDbId,
      claudeSessionId: dbSession.claude_session_id,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.claude_session_id)
    });

    this.sessions.set(sessionDbId, session);

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
    return this.getSimpleQueue().count() > 0;
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
    return this.getSimpleQueue().count();
  }

  /**
   * Get total active work (queued + currently processing)
   */
  getTotalActiveWork(): number {
    return this.getSimpleQueue().count();
  }

  /**
   * Check if any session is actively processing (has pending messages OR active generator)
   */
  isAnySessionProcessing(): boolean {
    return this.getSimpleQueue().count() > 0;
  }
}

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
import { getSupervisor } from '../../supervisor/index.js';
import { MAX_CONSECUTIVE_SUMMARY_FAILURES } from '../../sdk/prompts.js';
import { RestartGuard } from './RestartGuard.js';

/** Idle threshold before a stuck generator (zombie subprocess) is force-killed. */
export const MAX_GENERATOR_IDLE_MS = 5 * 60 * 1000; // 5 minutes

/** Idle threshold before a no-generator session with no pending work is reaped. */
export const MAX_SESSION_IDLE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Minimal process interface used by detectStaleGenerator — compatible with
 * both the real Bun.Subprocess / ChildProcess shapes and test mocks.
 */
export interface StaleGeneratorProcess {
  exitCode: number | null;
  kill(signal?: string): boolean | void;
}

/**
 * Minimal session fields required to evaluate stale-generator status.
 * This is a subset of ActiveSession, allowing unit tests to pass plain objects.
 */
export interface StaleGeneratorCandidate {
  generatorPromise: Promise<void> | null;
  lastGeneratorActivity: number;
  abortController: AbortController;
}

/**
 * Detect whether a session's generator is stuck (zombie subprocess) and, if so,
 * SIGKILL the subprocess and abort the controller.
 *
 * Extracted from reapStaleSessions() so tests can import and exercise the exact
 * same logic rather than duplicating it locally. (Issue #1652)
 *
 * @param session  - session to inspect
 * @param proc     - tracked subprocess (may be undefined if not in ProcessRegistry)
 * @param now      - current timestamp (defaults to Date.now(); pass explicit value in tests)
 * @returns true if the session was marked stale, false otherwise
 */
export function detectStaleGenerator(
  session: StaleGeneratorCandidate,
  proc: StaleGeneratorProcess | undefined,
  now = Date.now()
): boolean {
  if (!session.generatorPromise) return false;

  const generatorIdleMs = now - session.lastGeneratorActivity;
  if (generatorIdleMs <= MAX_GENERATOR_IDLE_MS) return false;

  // Kill subprocess to unblock stuck for-await
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch (error) {
      if (error instanceof Error) {
        logger.warn('SESSION', 'Failed to SIGKILL stale generator subprocess', {}, error);
      } else {
        logger.warn('SESSION', 'Failed to SIGKILL stale generator subprocess with non-Error', {}, new Error(String(error)));
      }
    }
  }
  // Signal the SDK agent loop to exit
  session.abortController.abort();
  return true;
}

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
      if (dbSession.platform_source && dbSession.platform_source !== session.platformSource) {
        session.platformSource = dbSession.platform_source;
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

    // Log warning if we're discarding a stale memory_session_id (Issue #817)
    if (dbSession.memory_session_id) {
      logger.warn('SESSION', `Discarding stale memory_session_id from previous worker instance (Issue #817)`, {
        sessionDbId,
        staleMemorySessionId: dbSession.memory_session_id,
        reason: 'SDK context lost on worker restart - will capture new ID'
      });
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
    // CRITICAL: Do NOT load memorySessionId from database here (Issue #817)
    // When creating a new in-memory session, any database memory_session_id is STALE
    // because the SDK context was lost when the worker restarted. The SDK agent will
    // capture a new memorySessionId on the first response and persist it.
    // Loading stale memory_session_id causes "No conversation found" crashes on resume.
    session = {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: null,  // Always start fresh - SDK will capture new ID
      project: dbSession.project,
      platformSource: dbSession.platform_source,
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
      currentProvider: null,  // Will be set when generator starts
      consecutiveRestarts: 0,  // DEPRECATED: use restartGuard. Kept for logging compat.
      restartGuard: new RestartGuard(),
      processingMessageIds: [],  // CLAIM-CONFIRM: Track message IDs for confirmProcessed()
      lastGeneratorActivity: Date.now(),  // Initialize for stale detection (Issue #1099)
      consecutiveSummaryFailures: 0,  // Circuit breaker for summary retry loop (#1633)
      pendingAgentId: null,   // Subagent identity carried from the most recent claimed message
      pendingAgentType: null  // (null for main-session messages)
    };

    logger.debug('SESSION', 'Creating new session object (memorySessionId cleared to prevent stale resume)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: '(cleared - will capture fresh from SDK)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id)
    });

    this.sessions.set(sessionDbId, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
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
      cwd: data.cwd,
      agentId: data.agentId,
      agentType: data.agentType
    };

    try {
      const messageId = this.getPendingStore().enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = this.getPendingStore().getPendingCount(sessionDbId);
      const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } catch (error) {
      if (error instanceof Error) {
        logger.error('SESSION', 'Failed to persist observation to DB', {
          sessionId: sessionDbId,
          tool: data.tool_name
        }, error);
      } else {
        logger.error('SESSION', 'Failed to persist observation to DB with non-Error', {
          sessionId: sessionDbId,
          tool: data.tool_name
        }, new Error(String(error)));
      }
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

    // Circuit breaker: skip summarize if too many consecutive failures (#1633).
    // This prevents the infinite loop where each failed summary spawns a new session
    // with an ever-growing prompt. Counter is in-memory per ActiveSession — it resets
    // on worker restart, which is acceptable because session state is already ephemeral.
    if (session.consecutiveSummaryFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) {
      logger.warn('SESSION', `Circuit breaker OPEN: skipping summarize after ${session.consecutiveSummaryFailures} consecutive failures (#1633)`, {
        sessionId: sessionDbId,
        contentSessionId: session.contentSessionId
      });
      return;
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
      if (error instanceof Error) {
        logger.error('SESSION', 'Failed to persist summarize to DB', {
          sessionId: sessionDbId
        }, error);
      } else {
        logger.error('SESSION', 'Failed to persist summarize to DB with non-Error', {
          sessionId: sessionDbId
        }, new Error(String(error)));
      }
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

    // 2. Wait for generator to finish (with 30s timeout to prevent stale stall, Issue #1099)
    if (session.generatorPromise) {
      const generatorDone = session.generatorPromise.catch(() => {
        logger.debug('SYSTEM', 'Generator already failed, cleaning up', { sessionId: session.sessionDbId });
      });
      const timeoutDone = new Promise<void>(resolve => {
        AbortSignal.timeout(30_000).addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([generatorDone, timeoutDone]).then(() => {}, () => {
        logger.warn('SESSION', 'Generator did not exit within 30s after abort, forcing cleanup (#1099)', { sessionDbId });
      });
    }

    // 3. Verify subprocess exit with 5s timeout (Issue #737 fix)
    const tracked = getProcessBySession(sessionDbId);
    if (tracked && tracked.process.exitCode === null) {
      logger.debug('SESSION', `Waiting for subprocess PID ${tracked.pid} to exit`, {
        sessionId: sessionDbId,
        pid: tracked.pid
      });
      await ensureProcessExit(tracked, 5000);
    }

    // 3b. Reap all supervisor-tracked processes for this session (#1351)
    // This catches MCP servers and other child processes not tracked by the
    // in-memory ProcessRegistry (e.g. processes registered only in supervisor.json).
    try {
      await getSupervisor().getRegistry().reapSession(sessionDbId);
    } catch (error) {
      if (error instanceof Error) {
        logger.warn('SESSION', 'Supervisor reapSession failed (non-blocking)', {
          sessionId: sessionDbId
        }, error);
      } else {
        logger.warn('SESSION', 'Supervisor reapSession failed (non-blocking) with non-Error', {
          sessionId: sessionDbId
        }, new Error(String(error)));
      }
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
   * Remove session from in-memory maps and notify without awaiting generator.
   * Used when SDK resume fails and we give up (no fallback): avoids deadlock
   * from deleteSession() awaiting the same generator promise we're inside.
   */
  removeSessionImmediate(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) return;

    this.sessions.delete(sessionDbId);
    this.sessionQueues.delete(sessionDbId);

    logger.info('SESSION', 'Session removed from active sessions', {
      sessionId: sessionDbId,
      project: session.project
    });

    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  /**
   * Evict the idlest session to free a pool slot (#1868).
   * An "idle" session has an active generator but no pending work — it's sitting
   * in the 3-min idle wait before subprocess cleanup. Evicting it triggers abort
   * which kills the subprocess and frees the pool slot for a waiting new session.
   * @returns true if a session was evicted, false if no idle sessions found
   */
  evictIdlestSession(): boolean {
    let idlestSessionId: number | null = null;
    let oldestActivity = Infinity;

    for (const [sessionDbId, session] of this.sessions) {
      if (!session.generatorPromise) continue; // No generator = no slot held
      const pendingCount = this.getPendingStore().getPendingCount(sessionDbId);
      if (pendingCount > 0) continue; // Has work to do, don't evict

      // Pick the session with the oldest lastGeneratorActivity (idlest)
      if (session.lastGeneratorActivity < oldestActivity) {
        oldestActivity = session.lastGeneratorActivity;
        idlestSessionId = sessionDbId;
      }
    }

    if (idlestSessionId === null) return false;

    const session = this.sessions.get(idlestSessionId);
    if (!session) return false;

    logger.info('SESSION', 'Evicting idle session to free pool slot for new request (#1868)', {
      sessionDbId: idlestSessionId,
      idleDurationMs: Date.now() - oldestActivity
    });

    session.idleTimedOut = true;
    session.abortController.abort();
    return true;
  }

  /**
   * Reap sessions with no active generator and no pending work that have been idle too long.
   * Also reaps sessions whose generator has been stuck (no lastGeneratorActivity update) for
   * longer than MAX_GENERATOR_IDLE_MS — these are zombie subprocesses that will never exit
   * on their own because the orphan reaper skips sessions in the active sessions map. (Issue #1652)
   *
   * This unblocks the orphan reaper which skips processes for "active" sessions. (Issue #1168)
   */
  async reapStaleSessions(): Promise<number> {
    const now = Date.now();
    const staleSessionIds: number[] = [];

    for (const [sessionDbId, session] of this.sessions) {
      // Sessions with active generators — check for stuck/zombie generators (Issue #1652)
      if (session.generatorPromise) {
        const generatorIdleMs = now - session.lastGeneratorActivity;
        if (generatorIdleMs > MAX_GENERATOR_IDLE_MS) {
          logger.warn('SESSION', `Stale generator detected for session ${sessionDbId} (no activity for ${Math.round(generatorIdleMs / 60000)}m) — force-killing subprocess`, {
            sessionDbId,
            generatorIdleMs
          });
          // Force-kill the subprocess to unblock the stuck for-await in SDKAgent.
          // Without this the generator is blocked on `for await (const msg of queryResult)`
          // and will never exit even after abort() is called.
          const trackedProcess = getProcessBySession(sessionDbId);
          if (trackedProcess && trackedProcess.process.exitCode === null) {
            try {
              trackedProcess.process.kill('SIGKILL');
            } catch (err) {
              if (err instanceof Error) {
                logger.warn('SESSION', 'Failed to SIGKILL subprocess for stale generator', { sessionDbId }, err);
              } else {
                logger.warn('SESSION', 'Failed to SIGKILL subprocess for stale generator with non-Error', { sessionDbId }, new Error(String(err)));
              }
            }
          }
          // Signal the SDK agent loop to exit after the subprocess dies
          session.abortController.abort();
          staleSessionIds.push(sessionDbId);
        }
        continue;
      }

      // Skip sessions with pending work
      const pendingCount = this.getPendingStore().getPendingCount(sessionDbId);
      if (pendingCount > 0) continue;

      // No generator + no pending work + old enough = stale
      const sessionAge = now - session.startTime;
      if (sessionAge > MAX_SESSION_IDLE_MS) {
        logger.warn('SESSION', `Reaping idle session ${sessionDbId} (no activity for >${Math.round(MAX_SESSION_IDLE_MS / 60000)}m)`, { sessionDbId });
        staleSessionIds.push(sessionDbId);
      }
    }

    for (const sessionDbId of staleSessionIds) {
      await this.deleteSession(sessionDbId);
    }

    return staleSessionIds.length;
  }

  /**
   * Shutdown all active sessions
   */
  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  /**
   * Check if any active session has pending messages (for spinner tracking).
   * Scoped to in-memory sessions only.
   */
  hasPendingMessages(): boolean {
    return this.getTotalQueueDepth() > 0;
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
   * Check if any active session has pending work.
   * Scoped to in-memory sessions only — orphaned DB messages from dead
   * sessions must not keep the spinner spinning forever.
   */
  isAnySessionProcessing(): boolean {
    return this.getTotalQueueDepth() > 0;
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
    // CRITICAL: Pass onIdleTimeout callback that triggers abort to kill the subprocess
    // Without this, the iterator returns but the Claude subprocess stays alive as a zombie
    for await (const message of processor.createIterator({
      sessionDbId,
      signal: session.abortController.signal,
      onIdleTimeout: () => {
        logger.info('SESSION', 'Triggering abort due to idle timeout to kill subprocess', { sessionDbId });
        session.idleTimedOut = true;
        session.abortController.abort();
      }
    })) {
      // Track earliest timestamp for accurate observation timestamps
      // This ensures backlog messages get their original timestamps, not current time
      if (session.earliestPendingTimestamp === null) {
        session.earliestPendingTimestamp = message._originalTimestamp;
      } else {
        session.earliestPendingTimestamp = Math.min(session.earliestPendingTimestamp, message._originalTimestamp);
      }

      // Update generator activity for stale detection (Issue #1099)
      session.lastGeneratorActivity = Date.now();

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

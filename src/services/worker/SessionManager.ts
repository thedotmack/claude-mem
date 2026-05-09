import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';
import {
  SqliteObservationQueueEngine,
  type HealthCheckedObservationQueueEngine,
  type InspectableObservationQueueEngine,
  type ObservationQueueHealth
} from '../../server/queue/ObservationQueueEngine.js';
import { BullMqObservationQueueEngine } from '../../server/queue/BullMqObservationQueueEngine.js';
import { getObservationQueueEngineName } from '../../server/queue/redis-config.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../supervisor/process-registry.js';
import { getSupervisor } from '../../supervisor/index.js';
import { RestartGuard } from './RestartGuard.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private onSessionDeletedCallback?: () => void;
  private queueEngine: InspectableObservationQueueEngine | null = null;
  private queueEngineName: 'sqlite' | 'bullmq' | null = null;
  private onPendingMutate?: () => void;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  private getQueueEngine(): InspectableObservationQueueEngine {
    if (!this.queueEngine) {
      this.queueEngineName = getObservationQueueEngineName();
      if (this.queueEngineName === 'bullmq') {
        this.queueEngine = new BullMqObservationQueueEngine({
          onMutate: () => this.onPendingMutate?.()
        });
      } else {
        const sessionStore = this.dbManager.getSessionStore();
        this.queueEngine = new SqliteObservationQueueEngine(
          sessionStore.db,
          () => this.onPendingMutate?.()
        );
      }
    }
    return this.queueEngine;
  }

  async initializeQueueEngine(): Promise<void> {
    this.queueEngineName = getObservationQueueEngineName();
    if (this.queueEngineName === 'sqlite') {
      return;
    }
    const queue = this.getQueueEngine();
    if (isHealthCheckedQueue(queue)) {
      await queue.assertHealthy();
      await queue.getTotalQueueDepth();
    }
  }

  isBullMqQueueEnabled(): boolean {
    return (this.queueEngineName ?? getObservationQueueEngineName()) === 'bullmq';
  }

  async getQueueHealth(): Promise<ObservationQueueHealth | null> {
    const queue = this.getQueueEngine();
    if (isHealthCheckedQueue(queue)) {
      return queue.getHealth();
    }
    return null;
  }

  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  setOnPendingMutate(cb: () => void): void {
    this.onPendingMutate = cb;
  }

  initializeSession(sessionDbId: number, currentUserPrompt?: string, promptNumber?: number): ActiveSession {
    logger.debug('SESSION', 'initializeSession called', {
      sessionDbId,
      promptNumber,
      has_currentUserPrompt: !!currentUserPrompt
    });

    let session = this.sessions.get(sessionDbId);
    if (session) {
      logger.debug('SESSION', 'Returning cached session', {
        sessionDbId,
        contentSessionId: session.contentSessionId,
        lastPromptNumber: session.lastPromptNumber
      });

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

    const dbSession = this.dbManager.getSessionById(sessionDbId);

    logger.debug('SESSION', 'Fetched session from database', {
      sessionDbId,
      content_session_id: dbSession.content_session_id,
      memory_session_id: dbSession.memory_session_id
    });

    if (dbSession.memory_session_id) {
      logger.warn('SESSION', `Discarding stale memory_session_id from previous worker instance (Issue #817)`, {
        sessionDbId,
        staleMemorySessionId: dbSession.memory_session_id,
        reason: 'SDK context lost on worker restart - will capture new ID'
      });
    }

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
      claimedMessageIds: [],
      conversationHistory: [],  // Initialize empty - will be populated by agents
      currentProvider: null,  // Will be set when generator starts
      consecutiveRestarts: 0,  // DEPRECATED: use restartGuard. Kept for logging compat.
      restartGuard: new RestartGuard(),
      lastGeneratorActivity: Date.now(),  // Initialize for stale detection (Issue #1099)
      pendingAgentId: null,   // Subagent identity carried from the most recent claimed message
      pendingAgentType: null  
    };

    logger.debug('SESSION', 'Creating new session object (memorySessionId cleared to prevent stale resume)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: '(cleared - will capture fresh from SDK)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id)
    });

    this.sessions.set(sessionDbId, session);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
      queueDepth: 0,
      hasGenerator: false
    });

    return session;
  }

  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  async queueObservation(sessionDbId: number, data: ObservationData): Promise<void> {
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
      cwd: data.cwd,
      agentId: data.agentId,
      agentType: data.agentType,
      toolUseId: data.toolUseId,
    };

    try {
      const queue = this.getQueueEngine();
      const messageId = await queue.enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = await queue.getPendingCount(sessionDbId);
      const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
      if (messageId === 0) {
        logger.debug('QUEUE', `DUP_SUPPRESSED | sessionDbId=${sessionDbId} | type=observation | tool=${toolSummary} | toolUseId=${data.toolUseId ?? 'null'} | depth=${queueDepth}`, {
          sessionId: sessionDbId
        });
      } else {
        logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary} | depth=${queueDepth}`, {
          sessionId: sessionDbId
        });
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.info('QUEUE', 'enqueue failed; observation dropped', {
        sessionId: sessionDbId,
        tool: data.tool_name,
        err: normalized.message
      });
      throw normalized;
    }

  }

  async queueSummarize(sessionDbId: number, lastAssistantMessage?: string): Promise<void> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'summarize',
      last_assistant_message: lastAssistantMessage
    };

    try {
      const queue = this.getQueueEngine();
      const messageId = await queue.enqueue(sessionDbId, session.contentSessionId, message);
      const queueDepth = await queue.getPendingCount(sessionDbId);
      if (messageId === 0) {
        logger.debug('QUEUE', `DUP_SUPPRESSED | sessionDbId=${sessionDbId} | type=summarize | depth=${queueDepth}`, {
          sessionId: sessionDbId
        });
      } else {
        logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=summarize | depth=${queueDepth}`, {
          sessionId: sessionDbId
        });
      }
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
      throw error; 
    }

  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    return await this.getQueueEngine().clearPendingForSession(sessionDbId);
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const session = this.sessions.get(sessionDbId);
    if (session) {
      session.claimedMessageIds = [];
    }
    return await this.getQueueEngine().resetProcessingToPending(sessionDbId);
  }

  async confirmClaimedMessages(sessionDbId: number): Promise<number> {
    const session = this.sessions.get(sessionDbId);
    const claimedIds = session?.claimedMessageIds ?? [];
    let confirmed = 0;
    for (const messageId of claimedIds) {
      confirmed += await this.getQueueEngine().confirmProcessed(messageId);
    }
    if (session) {
      session.claimedMessageIds = [];
      session.earliestPendingTimestamp = null;
    }
    return confirmed;
  }

  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return;
    }

    const sessionDuration = Date.now() - session.startTime;

    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
      session.respawnTimer = undefined;
    }

    session.abortReason = 'shutdown';
    session.abortController.abort();

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

    const tracked = getSdkProcessForSession(sessionDbId);
    if (tracked && tracked.process.exitCode === null) {
      logger.debug('SESSION', `Waiting for subprocess PID ${tracked.pid} (pgid ${tracked.pgid}) to exit`, {
        sessionId: sessionDbId,
        pid: tracked.pid,
        pgid: tracked.pgid
      });
      await ensureSdkProcessExit(tracked, 5000);
    }

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

    this.sessions.delete(sessionDbId);
    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project
    });

    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  removeSessionImmediate(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) return;

    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
      session.respawnTimer = undefined;
    }

    this.sessions.delete(sessionDbId);
    logger.info('SESSION', 'Session removed from active sessions', {
      sessionId: sessionDbId,
      project: session.project
    });

    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
  }

  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
    await this.queueEngine?.close();
    this.queueEngine = null;
  }

  async hasPendingMessages(): Promise<boolean> {
    return (await this.getTotalQueueDepth()) > 0;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  async getTotalQueueDepth(): Promise<number> {
    return await this.getQueueEngine().getTotalQueueDepth();
  }

  async getTotalActiveWork(): Promise<number> {
    return await this.getTotalQueueDepth();
  }

  async isAnySessionProcessing(): Promise<boolean> {
    return (await this.getTotalQueueDepth()) > 0;
  }

  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const queue = this.getQueueEngine();
    await this.resetProcessingToPending(sessionDbId);

    for await (const message of queue.createIterator({
      sessionDbId,
      signal: session.abortController.signal,
      onIdleTimeout: () => {
        logger.info('SESSION', 'Triggering abort due to idle timeout to kill subprocess', { sessionDbId });
        session.idleTimedOut = true;
        session.abortReason = 'idle';
        session.abortController.abort();
      }
    })) {
      session.claimedMessageIds.push(message._persistentId);
      if (session.earliestPendingTimestamp === null) {
        session.earliestPendingTimestamp = message._originalTimestamp;
      } else {
        session.earliestPendingTimestamp = Math.min(session.earliestPendingTimestamp, message._originalTimestamp);
      }

      session.lastGeneratorActivity = Date.now();

      yield message;
    }
  }

  getPendingMessageStore(): InspectableObservationQueueEngine {
    return this.getQueueEngine();
  }
}

function isHealthCheckedQueue(queue: InspectableObservationQueueEngine): queue is HealthCheckedObservationQueueEngine {
  return 'getHealth' in queue && 'assertHealthy' in queue;
}

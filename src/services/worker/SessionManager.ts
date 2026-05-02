
import { EventEmitter } from 'events';
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, ObservationData } from '../worker-types.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../supervisor/process-registry.js';
import { getSupervisor } from '../../supervisor/index.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;
  private onPendingMutate?: () => void;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
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
      conversationHistory: [],
      currentProvider: null,
      pendingAgentId: null,
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

  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  queueObservation(sessionDbId: number, data: ObservationData): void {
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

    session.pendingMessages.push(message);
    const toolSummary = logger.formatTool(data.tool_name, data.tool_input);
    logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | type=observation | tool=${toolSummary} | depth=${session.pendingMessages.length}`, {
      sessionId: sessionDbId
    });
    this.sessionQueues.get(sessionDbId)?.emit('message');
    this.onPendingMutate?.();
  }

  queueSummarize(sessionDbId: number, lastAssistantMessage?: string): void {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'summarize',
      last_assistant_message: lastAssistantMessage
    };

    session.pendingMessages.push(message);
    logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | type=summarize | depth=${session.pendingMessages.length}`, {
      sessionId: sessionDbId
    });
    this.sessionQueues.get(sessionDbId)?.emit('message');
    this.onPendingMutate?.();
  }

  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return;
    }

    const sessionDuration = Date.now() - session.startTime;

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
    this.sessionQueues.delete(sessionDbId);

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

  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  hasPendingMessages(): boolean {
    return this.getTotalQueueDepth() > 0;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getTotalQueueDepth(): number {
    let depth = 0;
    for (const session of this.sessions.values()) {
      depth += session.pendingMessages.length;
    }
    return depth;
  }

  getTotalActiveWork(): number {
    return this.getTotalQueueDepth();
  }

  isAnySessionProcessing(): boolean {
    return this.getTotalQueueDepth() > 0;
  }

  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessage> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }
    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    const signal = session.abortController.signal;

    while (!signal.aborted) {
      const msg = session.pendingMessages.shift();
      if (msg) {
        this.onPendingMutate?.();
        yield msg;
        continue;
      }
      await new Promise<void>(resolve => {
        const onMessage = () => { cleanup(); resolve(); };
        const onAbort = () => { cleanup(); resolve(); };
        const cleanup = () => {
          emitter.off('message', onMessage);
          signal.removeEventListener('abort', onAbort);
        };
        emitter.once('message', onMessage);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

}

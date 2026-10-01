import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import { redactForLog } from '../../utils/redaction.js';
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';
import { SessionMessageBuffer } from './SessionMessageBuffer.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../supervisor/process-registry.js';
import { getSupervisor } from '../../supervisor/index.js';
import { telemetryBuffer } from '../telemetry/buffer.js';
import { deliverSessionWrapup, type TelegramWrapupFormatter } from '../integrations/TelegramWrapupNotifier.js';
import { MAX_LLM_TIMEOUT_MS, resolveLlmTimeoutMs } from './retry.js';
import { isMemoryOnCmemGateway } from '../../shared/cmem-gateway.js';
import { planUnattendedGatewayResume, unattendedGatewayResumesSpent } from './session/response-pacer.js';

export const SESSION_END_WRAPUP_GRACE_MS = 5_000;

export interface TransportResumeClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const defaultTransportResumeClock: TransportResumeClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
};

// The nominal interval stops at the largest supported request timeout.
// Jitter remains after that cap so sessions that failed together do not
// synchronize their probes during a shared provider outage.
export const MAX_TRANSPORT_RESUME_BASE_DELAY_MS = MAX_LLM_TIMEOUT_MS;

export function transportResumeDelayMs(consecutivePauses: number): number {
  const nominalMs = Math.min(
    resolveLlmTimeoutMs() * Math.pow(2, Math.max(0, consecutivePauses - 1)),
    MAX_TRANSPORT_RESUME_BASE_DELAY_MS,
  );
  return Math.floor(nominalMs + Math.random() * nominalMs / 4);
}

type TransportResumeState = { pauses: number; timer?: ReturnType<typeof setTimeout> };
type ReadyTransportResume = {
  sessionDbId: number;
  session: ActiveSession;
  state: TransportResumeState;
};

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private onPendingMutate?: () => void;
  private telegramWrapupFormatter: TelegramWrapupFormatter | null = null;
  private readonly buffer = new SessionMessageBuffer(() => this.onPendingMutate?.());
  private generatorStarter: ((sessionDbId: number, source: string) => void | Promise<void>) | null = null;
  private transportResumes = new Map<number, TransportResumeState>();
  private transportResumeReady: ReadyTransportResume[] = [];
  private activeTransportResume: ReadyTransportResume | null = null;
  private deletingSessions = new Set<number>();
  private transportResumeDispositionEpochs = new WeakMap<ActiveSession, number>();

  constructor(
    dbManager: DatabaseManager,
    private readonly transportResumeClock: TransportResumeClock = defaultTransportResumeClock,
  ) {
    this.dbManager = dbManager;
  }

  setOnPendingMutate(cb: () => void): void {
    this.onPendingMutate = cb;
  }

  setGeneratorStarter(starter: (sessionDbId: number, source: string) => void | Promise<void>): void {
    this.generatorStarter = starter;
  }

  /** Resume preserved transport work without requiring another hook from the IDE. */
  scheduleTransportResume(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (!session || this.deletingSessions.has(sessionDbId) || this.buffer.getPendingCount(sessionDbId) === 0) return;
    if (!this.generatorStarter) {
      logger.error('SESSION', 'Cannot schedule transport resume: generator starter is not attached', { sessionId: sessionDbId });
      return;
    }

    const prior = this.transportResumes.get(sessionDbId);
    if (prior?.timer) this.transportResumeClock.clearTimeout(prior.timer);
    const pauses = (prior?.pauses ?? 0) + 1;
    // Each unattended resume on the cmem gateway spends plan tokens; this one
    // shares its budget with rate-limit and fallback resumes. Spent, the pause
    // keeps its backoff position without a timer, and the next hook-driven
    // start still drains the buffer.
    if (!planUnattendedGatewayResume(session, 'transport-resume', isMemoryOnCmemGateway()).resume) {
      this.transportResumes.set(sessionDbId, { pauses });
      return;
    }
    const delayMs = transportResumeDelayMs(pauses);
    const state: TransportResumeState = { pauses };
    const timer = this.transportResumeClock.setTimeout(() => {
      if (this.transportResumes.get(sessionDbId) !== state || state.timer !== timer) return;
      state.timer = undefined;
      const ready = { sessionDbId, session, state };
      if (!this.canResumeTransport(ready)) {
        this.transportResumes.delete(sessionDbId);
        return;
      }
      this.transportResumeReady.push(ready);
      this.pumpTransportResumes();
    }, delayMs);
    timer.unref?.();
    state.timer = timer;
    this.transportResumes.set(sessionDbId, state);
    logger.warn('SESSION', 'Transport pause: scheduled buffered-work resume', { sessionId: sessionDbId, pauses, delayMs });
  }

  private canResumeTransport(ready: ReadyTransportResume): boolean {
    return this.sessions.get(ready.sessionDbId) === ready.session
      && !this.deletingSessions.has(ready.sessionDbId)
      && this.transportResumes.get(ready.sessionDbId) === ready.state
      && this.buffer.getPendingCount(ready.sessionDbId) > 0;
  }

  /** Start one unattended probe at a time; ready sessions retain FIFO order. */
  private pumpTransportResumes(): void {
    if (this.activeTransportResume) return;
    while (this.transportResumeReady.length > 0) {
      const ready = this.transportResumeReady.shift()!;
      if (!this.canResumeTransport(ready)) continue;
      // A hook already restarted this session. Do not occupy the automatic
      // probe slot, but watch its completion. An explicit pause decision
      // clears the state, so it cannot rearm after the generator settles.
      if (ready.session.generatorPromise) {
        this.rearmAfterRunningGenerator(ready, ready.session.generatorPromise);
        continue;
      }
      this.activeTransportResume = ready;
      void Promise.resolve()
        .then(() => {
          if (!this.canResumeTransport(ready) || this.activeTransportResume !== ready) return;
          return this.generatorStarter?.(ready.sessionDbId, 'transport-resume');
        })
        .catch(error => {
          logger.error('SESSION', 'Failed to resume observer after transport pause', { sessionId: ready.sessionDbId },
            error instanceof Error ? error : new Error(String(error)));
        })
        .then(() => {
          if (this.activeTransportResume !== ready) return;
          const generator = ready.session.generatorPromise;
          if (!generator) {
            // Quota and overflow admission can decline without a generator exit.
            this.finishTransportResume(ready);
            return;
          }
          void generator.then(
            () => this.finishTransportResume(ready),
            () => this.finishTransportResume(ready),
          );
        });
      return;
    }
  }

  private rearmAfterRunningGenerator(ready: ReadyTransportResume, running: Promise<void>): void {
    const onSettled = () => {
      if (!this.canResumeTransport(ready) || ready.state.timer) return;
      const current = ready.session.generatorPromise;
      if (current && current !== running) {
        this.rearmAfterRunningGenerator(ready, current);
        return;
      }
      // A failed finalizer can leave its already-settled promise in the
      // session. It no longer owns the generator slot, so clear that stale
      // reference before scheduling the next attempt.
      if (current === running) ready.session.generatorPromise = null;
      try {
        this.scheduleTransportResume(ready.sessionDbId);
      } catch (error) {
        logger.error('SESSION', 'Failed to rearm transport resume after hook generator', { sessionId: ready.sessionDbId },
          error instanceof Error ? error : new Error(String(error)));
      }
    };
    void running.then(onSettled, onSettled);
  }

  private finishTransportResume(ready: ReadyTransportResume): void {
    if (this.activeTransportResume !== ready) return;
    this.activeTransportResume = null;
    // A declined start has no exit to schedule its next attempt. A completed
    // generator may have scheduled a new state; the identity check excludes it.
    try {
      if (this.canResumeTransport(ready) && !ready.state.timer
        && !ready.session.generatorPromise) {
        this.scheduleTransportResume(ready.sessionDbId);
      }
    } catch (error) {
      logger.error('SESSION', 'Failed to schedule another transport resume', { sessionId: ready.sessionDbId },
        error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pumpTransportResumes();
    }
  }

  clearTransportResume(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (session) {
      this.transportResumeDispositionEpochs.set(session,
        (this.transportResumeDispositionEpochs.get(session) ?? 0) + 1);
    }
    const state = this.transportResumes.get(sessionDbId);
    if (state?.timer) this.transportResumeClock.clearTimeout(state.timer);
    this.transportResumes.delete(sessionDbId);
    if (this.activeTransportResume?.sessionDbId === sessionDbId) {
      this.activeTransportResume = null;
      this.pumpTransportResumes();
    }
  }

  setTelegramWrapupFormatter(formatter: TelegramWrapupFormatter): void {
    this.telegramWrapupFormatter = formatter;
  }

  initializeSession(
    sessionDbId: number,
    currentUserPrompt?: string,
    promptNumber?: number,
    currentProject?: string,
  ): ActiveSession {
    const suppliedProject = currentProject && currentProject !== 'unknown' ? currentProject : undefined;

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
      if (dbSession.project && dbSession.project !== session.project && !suppliedProject) {
        logger.debug('SESSION', 'Updating project from database', {
          sessionDbId,
          oldProject: session.project,
          newProject: dbSession.project
        });
        session.project = dbSession.project;
      }
      if (suppliedProject) {
        session.project = suppliedProject;
      }
      if (dbSession.platform_source && dbSession.platform_source !== session.platformSource) {
        session.platformSource = dbSession.platform_source;
      }
      if (dbSession.observed_model && dbSession.observed_model !== session.observedModel) {
        session.observedModel = dbSession.observed_model;
      }
      if (dbSession.observed_billing && dbSession.observed_billing !== session.observedBilling) {
        session.observedBilling = dbSession.observed_billing;
      }

      if (currentUserPrompt) {
        logger.debug('SESSION', 'Updating userPrompt for continuation', {
          sessionDbId,
          promptNumber,
          oldPrompt: session.userPrompt?.substring(0, 80) ?? '',
          newPrompt: currentUserPrompt.substring(0, 80)
        });
        session.userPrompt = currentUserPrompt;
        session.lastPromptNumber = promptNumber || session.lastPromptNumber;
      } else {
        logger.debug('SESSION', 'No currentUserPrompt provided for existing session', {
          sessionDbId,
          promptNumber,
          usingCachedPrompt: session.userPrompt?.substring(0, 80) ?? ''
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

    const latestPromptText = currentUserPrompt
      ? null
      : this.dbManager.getSessionStore().getLatestPromptTextFromUserPrompts(
          dbSession.content_session_id,
          sessionDbId,
        );
    const userPrompt = currentUserPrompt || latestPromptText || dbSession.user_prompt;

    if (!currentUserPrompt) {
      logger.debug('SESSION', latestPromptText
        ? 'No currentUserPrompt provided for new session, using latest user_prompts'
        : 'No currentUserPrompt provided for new session, using database', {
        sessionDbId,
        promptNumber,
        latestPrompt: latestPromptText?.substring(0, 80) ?? '',
        dbPrompt: dbSession.user_prompt?.substring(0, 80) ?? ''
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
      project: suppliedProject || dbSession.project,
      platformSource: dbSession.platform_source,
      observedModel: dbSession.observed_model ?? undefined,
      observedBilling: dbSession.observed_billing ?? undefined,
      userPrompt,
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id, sessionDbId),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      claimedMessageIds: [],
      conversationHistory: [],  // Initialize empty - will be populated by agents
      currentProvider: null,  // Will be set when generator starts
      consecutiveRestarts: 0,
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      lastGeneratorActivity: Date.now(),  // Initialize for stale detection (Issue #1099)
      pendingAgentId: null,   // Subagent identity carried from the most recent claimed message
      pendingAgentType: null,
      pausedReason: null
    };

    logger.debug('SESSION', 'Creating new session object (memorySessionId cleared to prevent stale resume)', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      dbMemorySessionId: dbSession.memory_session_id || '(none in DB)',
      memorySessionId: '(cleared - will capture fresh from SDK)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id, sessionDbId)
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

  isSessionDeleting(sessionDbId: number): boolean {
    return this.deletingSessions.has(sessionDbId);
  }

  private deliverSessionWrapupInBackground(sessionDbId: number): void {
    const formatSummary = this.telegramWrapupFormatter;
    if (!formatSummary) {
      logger.warn('TELEGRAM', 'Telegram session wrap-up formatter is unavailable', {
        sessionId: sessionDbId,
      });
      return;
    }

    void deliverSessionWrapup({
      sessionStore: this.dbManager.getSessionStore(),
      sessionDbId,
      formatSummary,
    }).catch((error: unknown) => {
      logger.warn('TELEGRAM', 'Failed to deliver Telegram session wrap-up from SessionManager', {
        sessionId: sessionDbId,
      }, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private takeRequestedSessionWrapup(session: ActiveSession): boolean {
    if (session.telegramWrapupTimer != null) {
      clearTimeout(session.telegramWrapupTimer);
      session.telegramWrapupTimer = null;
    }

    return session.telegramWrapupRequestedAt != null;
  }

  /** SessionEnd is the sole producer of this marker; Stop only queues a summary. */
  async requestSessionWrapup(sessionDbId: number): Promise<void> {
    const session = this.getSession(sessionDbId);
    if (!session) {
      this.deliverSessionWrapupInBackground(sessionDbId);
      return;
    }

    session.telegramWrapupRequestedAt = Date.now();
    if (session.telegramWrapupTimer != null) {
      clearTimeout(session.telegramWrapupTimer);
    }
    session.telegramWrapupTimer = setTimeout(() => {
      session.telegramWrapupTimer = null;
      this.deliverSessionWrapupInBackground(sessionDbId);
    }, SESSION_END_WRAPUP_GRACE_MS);
    session.telegramWrapupTimer.unref?.();
  }

  /** Called after a summary write; the SessionEnd marker preserves Stop-only silence. */
  deliverRequestedSessionWrapup(sessionDbId: number): void {
    const session = this.getSession(sessionDbId);
    if (session?.telegramWrapupRequestedAt == null) {
      return;
    }
    this.deliverSessionWrapupInBackground(sessionDbId);
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

    const messageId = this.buffer.enqueue(sessionDbId, message);
    const queueDepth = this.buffer.getPendingCount(sessionDbId);
    const toolSummary = redactForLog(logger.formatTool(data.tool_name, data.tool_input));
    if (messageId === 0) {
      logger.debug('QUEUE', `DUP_SUPPRESSED | sessionDbId=${sessionDbId} | type=observation | tool=${toolSummary} | toolUseId=${data.toolUseId ?? 'null'} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } else {
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=observation | tool=${toolSummary} | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
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

    const messageId = this.buffer.enqueue(sessionDbId, message);
    const queueDepth = this.buffer.getPendingCount(sessionDbId);
    if (messageId === 0) {
      logger.debug('QUEUE', `DUP_SUPPRESSED | sessionDbId=${sessionDbId} | type=summarize | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    } else {
      logger.info('QUEUE', `ENQUEUED | sessionDbId=${sessionDbId} | messageId=${messageId} | type=summarize | depth=${queueDepth}`, {
        sessionId: sessionDbId
      });
    }
  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    return this.buffer.clear(sessionDbId);
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const session = this.sessions.get(sessionDbId);
    if (session) {
      session.claimedMessageIds = [];
    }
    return this.buffer.resetClaimed(sessionDbId);
  }

  async confirmClaimedMessages(sessionDbId: number): Promise<number> {
    const session = this.sessions.get(sessionDbId);
    const claimedIds = session?.claimedMessageIds ?? [];
    let confirmed = 0;
    for (const messageId of claimedIds) {
      confirmed += this.buffer.confirm(messageId);
    }
    if (session) {
      session.claimedMessageIds = [];
      session.earliestPendingTimestamp = null;
    }
    if (confirmed > 0) {
      const state = this.transportResumes.get(sessionDbId);
      if (state?.timer) this.transportResumeClock.clearTimeout(state.timer);
      if (state) {
        state.timer = undefined;
        state.pauses = 0;
      }
      // The generator can remain alive for its idle window after draining
      // queued work. Free the shared probe slot as soon as it is done sending.
      if (this.buffer.getPendingCount(sessionDbId) === 0) this.clearTransportResume(sessionDbId);
    }
    return confirmed;
  }

  getClaimedMessages(sessionDbId: number): PendingMessageWithId[] {
    const session = this.sessions.get(sessionDbId);
    const claimedIds = session?.claimedMessageIds ?? [];
    return this.buffer.getMessagesByIds(sessionDbId, claimedIds);
  }

  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session || this.deletingSessions.has(sessionDbId)) {
      return;
    }
    const priorTransportPauses = this.transportResumes.get(sessionDbId)?.pauses;
    const priorAbortCategory = (session.abortReason ?? '').split(':')[0];
    let dispositionEpoch: number | undefined;
    // Fence delayed transport callbacks before the async teardown can yield.
    this.deletingSessions.add(sessionDbId);
    try {
      this.clearTransportResume(sessionDbId);
      dispositionEpoch = this.transportResumeDispositionEpochs.get(session);

      // Phase 2: emit this session's single observer_turn_rollup at session end,
      // while the session still exists. flushSession removes the bucket, so the
      // matching call in removeSessionImmediate (or a re-entry here) is a safe
      // no-op. Never throws — telemetry is fire-and-forget.
      telemetryBuffer.flushSession(sessionDbId, 'session_end');

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

      if (this.takeRequestedSessionWrapup(session)) {
        this.deliverSessionWrapupInBackground(sessionDbId);
      }
      this.clearTransportResume(sessionDbId);
      this.buffer.dispose(sessionDbId);
      this.sessions.delete(sessionDbId);
      logger.info('SESSION', 'Session deleted', {
        sessionId: sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        project: session.project
      });
    } finally {
      // A teardown failure leaves the session and its buffered work alive.
      // Release the deletion fence and restore only a pre-existing transport
      // pause; quota/auth pauses must continue to wait for their own trigger.
      const stillCurrent = this.sessions.get(sessionDbId) === session;
      const currentAbortCategory = (session.abortReason ?? '').split(':')[0];
      if (stillCurrent && session.abortReason === 'shutdown') session.abortReason = null;
      this.deletingSessions.delete(sessionDbId);
      if (stillCurrent && priorTransportPauses !== undefined
        && dispositionEpoch !== undefined
        && this.transportResumeDispositionEpochs.get(session) === dispositionEpoch
        && !['quota', 'auth', 'overflow', 'provider_switch'].includes(priorAbortCategory)
        && !['quota', 'auth', 'overflow', 'provider_switch'].includes(currentAbortCategory)
        && !this.transportResumes.has(sessionDbId) && this.buffer.getPendingCount(sessionDbId) > 0) {
        // scheduleTransportResume increments pauses; retain the original
        // backoff position rather than treating teardown as a new failure.
        this.transportResumes.set(sessionDbId, { pauses: Math.max(0, priorTransportPauses - 1) });
        try {
          this.scheduleTransportResume(sessionDbId);
        } catch (error) {
          this.transportResumes.delete(sessionDbId);
          logger.error('SESSION', 'Failed to restore transport resume after teardown error', { sessionId: sessionDbId },
            error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  removeSessionImmediate(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) return;

    // Phase 2: same session-end rollup as deleteSession. Whichever teardown
    // path runs first flushes; flushSession removes the bucket so the second is
    // a no-op (guards against the deleteSession/removeSessionImmediate pair).
    telemetryBuffer.flushSession(sessionDbId, 'session_end');

    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
      session.respawnTimer = undefined;
    }

    if (this.takeRequestedSessionWrapup(session)) {
      this.deliverSessionWrapupInBackground(sessionDbId);
    }

    this.clearTransportResume(sessionDbId);
    this.buffer.dispose(sessionDbId);
    this.sessions.delete(sessionDbId);
    logger.info('SESSION', 'Session removed from active sessions', {
      sessionId: sessionDbId,
      project: session.project
    });
  }

  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Snapshot paused in-memory work without loading sessions or changing the buffer.
   * The automatic sweep resumes only pauses that time heals, each paced or
   * capped where it is armed. A rate-limit pause is retried like a quota pause:
   * the breaker it armed paces it. The sweep leaves a session to a resume it
   * scheduled for itself, too: a rate limit must not be retried before its
   * Retry-After. With memory on the cmem gateway, a session whose unattended
   * resumes are spent is left for its next hook as well: the sweep is one more
   * unattended retry, and letting it through would make that budget meaningless.
   *
   * It leaves out pauses that a retry on a timer cannot heal. Each one waits
   * for the next captured event or an operator retry (`POST /api/processing`)
   * until the per-reason resume scheduler gives it a bounded retry:
   *  - a setup failure (`setup_required`), until the Claude CLI or the data
   *    directory is repaired. The start gate rechecks it on the next event;
   *  - an observer that spent its overflow recycles (`overflowPausedUntilMs`):
   *    a message that fits no generation aborts again on every retry, which
   *    the sweep repeated every cooldown, forever.
   */
  getResumableSessionIds(includeOperatorOnly: boolean = false): number[] {
    const automaticallyRetryable = new Set([null, undefined, 'quota', 'rate_limit', 'overflow', 'provider_switch', 'response_stall']);
    const memoryOnCmemGateway = !includeOperatorOnly && isMemoryOnCmemGateway();
    return Array.from(this.sessions.values())
      .filter(session => !session.generatorPromise
        && this.buffer.getPendingCount(session.sessionDbId) > 0
        && (includeOperatorOnly || !(session.pausedReason === 'response_stall' && session.stallResumeTimer !== undefined))
        && (includeOperatorOnly || session.overflowPausedUntilMs === undefined)
        && (includeOperatorOnly || session.scheduledResumeTimer === undefined)
        && (includeOperatorOnly || !(memoryOnCmemGateway && unattendedGatewayResumesSpent(session)))
        && (includeOperatorOnly || automaticallyRetryable.has(session.pausedReason)))
      .map(session => session.sessionDbId);
  }

  getTotalQueueDepth(): number {
    return this.buffer.getTotalDepth();
  }

  async getTotalActiveWork(): Promise<number> {
    return this.getTotalQueueDepth();
  }

  async isAnySessionProcessing(): Promise<boolean> {
    return this.getTotalQueueDepth() > 0;
  }

  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    // Re-yield anything a prior generator pass claimed but did not confirm.
    await this.resetProcessingToPending(sessionDbId);

    for await (const message of this.buffer.drain({
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

  /** Read-only access to the in-RAM buffer for diagnostics. */
  getMessageBuffer(): SessionMessageBuffer {
    return this.buffer;
  }
}

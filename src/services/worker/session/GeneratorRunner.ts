import { logger } from '../../../utils/logger.js';
import type { ActiveSession } from '../../worker-types.js';
import type { WorkerService } from '../../worker-service.js';
import type { SessionManager } from '../SessionManager.js';
import type { ClaudeProvider } from '../ClaudeProvider.js';
import type { GeminiProvider } from '../GeminiProvider.js';
import type { OpenRouterProvider } from '../OpenRouterProvider.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { recordCmemFallbackIfEligible, releaseCmemGatewayProbe } from '../provider-dispatch.js';
import { handleGeneratorExit } from './GeneratorExitHandler.js';
import { normalizeAbortReason } from './abort-reason.js';
import {
  MAX_CONSECUTIVE_STALL_RESUMES,
  RESPONSE_STALL_RESUME_DELAY_MS,
  planRateLimitResume,
  planResponseStallResume,
  planUnattendedGatewayResume,
} from './response-pacer.js';
import { telemetryBuffer } from '../../telemetry/buffer.js';
import { observerUsageLogFields } from '../observer-usage.js';
import { recordObserverFailure } from '../../../shared/observer-health.js';
import { recordClaudeSetupRequired } from '../../../shared/dependency-health.js';
import { isMemoryOnCmemGateway } from '../../../shared/cmem-gateway.js';
import {
  releaseQuotaProbe,
  recordAuthCooldown,
  recordQuotaExhausted,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
} from '../../../shared/quota-cooldown.js';
import { DEADLINE_EXCEEDED_CODE, isClassified, describeProviderError, type ClassifiedProviderError } from '../provider-errors.js';

export interface GeneratorRunnerDependencies {
  sessionManager: SessionManager;
  sdkAgent: ClaudeProvider;
  geminiAgent: GeminiProvider;
  openRouterAgent: OpenRouterProvider;
  workerService: WorkerService;
  completionHandler: SessionCompletionHandler;
  ensureGeneratorRunning: (sessionDbId: number, source: string) => Promise<void>;
  /**
   * SessionRoutes' once-per-process self-heal for a Claude CLI that is on disk
   * but no longer spawnable (#3291). Returns true when a worker restart was
   * triggered.
   */
  maybeSelfHealStaleClaudeSpawn: (error: unknown, source: string, sessionDbId: number) => boolean;
}

/**
 * Book a deadline expiry in the observer-health ledger.
 *
 * The provider pauses on it: it aborts the controller, so the finally books
 * the turn once as aborted and the buffered work survives, and the catch
 * keeps transient pauses out of the ledger. But nothing was stored. A
 * backend that is always slower than CLAUDE_MEM_LLM_TIMEOUT_MS would store
 * nothing and never raise the session-start warning. The error's own code
 * and remedy (raise the deadline) let the warning say what to do, and age it
 * into a last-known note once nothing has re-tested it
 * (isDeadlineFailureStale). Every other transient pause stays out of the
 * ledger: a network blip is not an outage.
 *
 * Only while this session is still the registered one. OpenAI-compatible
 * queries do not take the session's abort signal, so a deleted session's
 * request runs on to its deadline with nobody waiting for the answer.
 */
function recordDeadlineExpiry(
  provider: 'claude' | 'gemini' | 'openrouter',
  session: ActiveSession,
  error: unknown,
  sessionManager: SessionManager,
): void {
  if (!isClassified(error) || error.code !== DEADLINE_EXCEEDED_CODE) return;
  if (sessionManager.getSession(session.sessionDbId) !== session) return;
  recordObserverFailure(provider, {
    message: error.message,
    kind: error.kind,
    code: error.code,
    action: error.action,
  });
}

export async function startGeneratorWithProvider(
  session: ActiveSession | undefined,
  provider: 'claude' | 'gemini' | 'openrouter',
  source: string,
  /** The quota probe this run claimed, or null when it was admitted without one. */
  quotaProbeClaimId: number | null,
  /** The cmem-gateway re-probe this run claimed, or null when it took none. */
  gatewayProbeClaimId: number | null,
  deps: GeneratorRunnerDependencies,
): Promise<void> {
  const { sessionManager, sdkAgent, geminiAgent, openRouterAgent, workerService,
    completionHandler, ensureGeneratorRunning, maybeSelfHealStaleClaudeSpawn } = deps;
  if (!session) return;

  // A generator is starting, so a pending resume has nothing left to do.
  if (session.stallResumeTimer !== undefined) {
    clearTimeout(session.stallResumeTimer);
    session.stallResumeTimer = undefined;
  }
  if (session.scheduledResumeTimer !== undefined) {
    clearTimeout(session.scheduledResumeTimer);
    session.scheduledResumeTimer = undefined;
  }
  // The last pause no longer describes this session; if this run pauses
  // too, its exit records a fresh reason. Without this, one auth pause would
  // keep the session out of every automatic sweep for good.
  session.pausedReason = null;

  if (session.abortController.signal.aborted) {
    logger.debug('SESSION', 'Resetting aborted AbortController before starting generator', {
      sessionId: session.sessionDbId
    });
    session.abortController = new AbortController();
  }

  const agent = provider === 'openrouter' ? openRouterAgent : (provider === 'gemini' ? geminiAgent : sdkAgent);
  const agentName = provider === 'openrouter' ? 'OpenRouter' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');

  const actualQueueDepth = sessionManager.getMessageBuffer().getPendingCount(session.sessionDbId);

  logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
    sessionId: session.sessionDbId,
    queueDepth: actualQueueDepth,
    historyLength: session.conversationHistory.length
  });

  session.currentProvider = provider;
  session.lastGeneratorActivity = Date.now();
  // Providers refine this per-prompt ('init'|'ingest'|'summarize'); this is
  // the fallback when a generator dies before dispatching its first prompt.
  session.lastGeneratorSource = source;

  const myController = session.abortController;

  let skipGeneratorExitFinalization = false;
  // Set when the catch below settled this run's failure itself. The finally
  // then leaves it alone: one failure is booked once.
  let failureBooked = false;
  // Set when the catch decided this paused session resumes on its own: at
  // once on the Anthropic plan after a cmem fallback, or after a rate limit's
  // Retry-After. The finally schedules it.
  let scheduledResume: { afterMs: number; source: string } | null = null;
  let generatorPromise: Promise<void>;

  generatorPromise = agent.startSession(session, workerService)
    .catch(async error => {
      const classified = isClassified(error) ? error : null;
      // Since #3999 a provider PAUSES on a classified error by aborting the
      // controller before rethrowing, so an aborted controller alone no longer
      // means an external abort. Only an unclassified rejection after an abort
      // is one (idle, shutdown, a provider switch) — nothing to book.
      if (myController.signal.aborted && !classified) {
        logger.debug('HTTP', 'Generator catch: ignoring error after abort', { sessionId: session.sessionDbId });
        return;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      if (provider === 'claude' && isClassified(error) && error.kind === 'setup_required') {
        skipGeneratorExitFinalization = true;
        session.pausedReason = 'setup_required';
        recordClaudeSetupRequired(error);
        maybeSelfHealStaleClaudeSpawn(error, source, session.sessionDbId);
        logger.warn('SESSION', 'Claude generator start requires setup; future Claude starts will be skipped until repaired', {
          sessionId: session.sessionDbId,
          provider,
          error: error.message,
        });
        return;
      }

      if (errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')) {
        logger.warn('SESSION', 'Generator killed by external signal', {
          sessionId: session.sessionDbId,
          provider,
          error: errorMsg
        });
        myController.abort();
        return;
      }

      // No retry here: a paused run keeps its buffered work for the next
      // generator, and a failed one leaves the transcript as the recovery
      // path. The next observation ingest starts a fresh generator via
      // ensureGeneratorRunning.
      failureBooked = true;

      // The cmem gateway stopped serving this account, or the post-window
      // re-probe failed: memory runs on the Anthropic plan — the promised
      // switch, not an outage — so it is neither booked into the health
      // ledger nor given a breaker (a 30-min breaker over the marker's 15-min
      // window would leave memory on neither), and the finally resumes it.
      if (provider === 'openrouter' && recordCmemFallbackIfEligible(error, gatewayProbeClaimId)) {
        // Moving the buffered work to the Anthropic plan is itself an
        // unattended retry, so it draws on the gateway's unattended budget —
        // a fallback only ever happens with memory on the gateway.
        if (planUnattendedGatewayResume(session, 'cmem-fallback', true).resume) {
          scheduledResume = { afterMs: 0, source: 'cmem-fallback' };
        }
        // The gateway's words and request id, which its copy asks users to
        // quote to support.
        logger.warn('SESSION', 'cmem gateway is not serving this account; memory runs on the Anthropic plan provider', {
          sessionId: session.sessionDbId,
          ...(classified ? { kind: classified.kind } : {}),
          ...(classified?.code ? { code: classified.code } : {}),
          ...(classified?.requestId ? { requestId: classified.requestId } : {}),
        }, classified ? describeProviderError(classified) : errorMsg);
      } else if (classified?.kind === 'transient' && myController.signal.aborted) {
        recordDeadlineExpiry(provider, session, classified, sessionManager);
        // The provider PAUSED on a deadline or an upstream fault that outlived
        // its own retries: the batch is kept for the next generator. A fault
        // is not an observer failure — counting these would raise the outage
        // banner over blips that clear on their own. Our own deadline is the
        // exception, booked just above with its own remedy and aging. A
        // transient error that did not pause the run (Claude's overloaded or
        // unknown errors) ended it, and is booked below like any other failure.
        logger.debug('SESSION', 'Observer paused on a transient provider failure; buffered work kept', {
          sessionId: session.sessionDbId,
          provider,
          ...(classified.requestId ? { requestId: classified.requestId } : {}),
        }, describeProviderError(classified));
      } else if (classified) {
        // The single error-level line for a classified provider failure:
        // code, message, action, link, and request id — same words the
        // gateway sent. Pass the rendered string (not the Error): classified
        // errors are user-state (quota/auth/rate-limit), not bugs, so the
        // errorSink/captureException isn't fired for them at all.
        logger.error('SESSION', 'Observer failed', {
          sessionId: session.sessionDbId,
          provider,
          kind: classified.kind,
          ...(classified.code ? { code: classified.code } : {}),
          ...(classified.requestId ? { requestId: classified.requestId } : {}),
          ...observerUsageLogFields(session),
        }, describeProviderError(classified));
        const resumeAfterMs = bookClassifiedFailure(session, provider, classified);
        if (resumeAfterMs !== null) scheduledResume = { afterMs: resumeAfterMs, source: 'rate-limit' };
      } else {
        logger.error('SESSION', 'Generator failed', {
          sessionId: session.sessionDbId,
          provider,
          error: errorMsg,
          ...observerUsageLogFields(session),
        }, error);
        recordObserverFailure(provider, errorMsg);
      }

      // A pause (the provider aborted) is counted by the finally under its
      // abort reason; only a run that ended on the error itself is 'error'.
      // The local error line (full fidelity) and this scrubbed rollup are
      // one logical event.
      if (!myController.signal.aborted) {
        telemetryBuffer.record('session_compressed', session.sessionDbId, {
          outcome: 'error',
          provider,
          // Providers seed lastModelId when they start; 'unknown' covers a
          // generator that died before resolving its model.
          model: session.lastModelId ?? 'unknown',
          error_category: 'provider_error',
          hook: session.lastGeneratorSource,
          ide: session.platformSource,
          observed_model: session.observedModel,
          observed_billing: session.observedBilling,
        });
      }
    })
    .finally(async () => {
      if (skipGeneratorExitFinalization) {
        // Setup needs operator repair. A transport timer from an earlier
        // failure must not restart Claude while that setup gate is active.
        sessionManager.clearTransportResume(session.sessionDbId);
        if (session.generatorPromise === generatorPromise) {
          session.generatorPromise = null;
        }
        if (session.currentProvider === provider) {
          session.currentProvider = null;
        }
        // This run is over even though it skips finalization, so it must not
        // keep holding the probe.
        releaseQuotaProbe(provider, quotaProbeClaimId);
        releaseCmemGatewayProbe(gatewayProbeClaimId);
        return;
      }

      const reason = session.abortReason ?? null;
      session.abortReason = null;  // consume the reason
      const normalizedReason = normalizeAbortReason(reason);
      // Quota surfaced as assistant prose — or Claude's proactive usage guard
      // — aborts without throwing, so it never reaches the catch; book it
      // here, arming the breaker too, or the prose path keeps the
      // per-observation request storm the classified path no longer has.
      // A thrown classified error was already booked by the catch, once: it
      // is never re-booked here as a spent allowance (a rate limit is not
      // one), nor given a breaker over a cmem fallback's window.
      if (normalizedReason === 'quota' && !failureBooked) {
        const quotaMessage = 'Provider reported the inference allowance exhausted';
        recordQuotaExhausted(provider, quotaMessage, reason?.split(':')[1], undefined, session.observerProfile);
        // Quota returned as assistant prose never throws, so it never reaches
        // the .catch above and never armed the health ledger. Without this the
        // session-start warning is structurally blind to an entire outage
        // class: the allowance is spent, no observation will ever store, and
        // the user is told nothing.
        recordObserverFailure(provider, { message: quotaMessage, kind: 'quota_exhausted' });
      }
      // A signed-out Claude observer answers with the CLI's own prose ("Not
      // logged in · Please run /login"). ResponseProcessor resets the batch to
      // pending and aborts with 'auth:observer_text' rather than throwing, so
      // it never reaches the .catch above. Without this the observer-health
      // ledger stays green through a full auth outage — every observation is
      // dropped, yet /api/health and the session-start warning report healthy
      // (#4150). Only that Claude prose path is booked here: a classified auth
      // error is booked by the .catch with the provider's own words, and the
      // cmem gateway's key_invalid is the trial-expiry fallback, not an outage.
      // It is booked as the refused credential it is (auth_invalid), so the
      // SessionStart banner shows at once with the /login remedy rather than
      // waiting out the failure threshold and then offering a restart.
      if (reason === 'auth:observer_text' && provider === 'claude' && !failureBooked) {
        recordObserverFailure(provider, {
          message: 'Claude Code reported the observer as signed out',
          kind: 'auth_invalid',
          action: 'Run /login in Claude Code (or `claude auth login` in a terminal) to refresh the observer credentials',
        });
      }
      if (reason !== null) {
        // Abort accounting lives HERE, where the reason is consumed — the
        // ONLY point every abort flow (idle / shutdown / overflow / quota)
        // passes through. Emit the closed enum, never the raw
        // string ('quota:…' carries a window suffix).
        telemetryBuffer.record('session_compressed', session.sessionDbId, {
          outcome: 'aborted',
          provider,
          model: session.lastModelId ?? 'unknown',
          abort_reason: normalizedReason,
          hook: session.lastGeneratorSource,
          ide: session.platformSource,
          observed_model: session.observedModel,
          observed_billing: session.observedBilling,
        });
      }
      // Every generator exit releases any probe this run claimed. Success
      // already deleted the breaker and a fresh refusal already re-armed it;
      // this covers aborts and crashes, so a claim can never outlive its
      // request and wedge the provider shut.
      releaseQuotaProbe(provider, quotaProbeClaimId);
      releaseCmemGatewayProbe(gatewayProbeClaimId);

      await handleGeneratorExit(session, reason, {
        sessionManager: sessionManager,
        completionHandler: completionHandler,
        resumeGenerator: resumeSource => resumeGeneratorLater(session, 0, resumeSource, ensureGeneratorRunning),
      });

      // Paused work that nothing else is guaranteed to pick up resumes on its
      // own — without it, a session's last event (a summarize) stays in RAM:
      //  - a cmem fallback (or a failed gateway re-probe) moves to the
      //    Anthropic plan at once;
      //  - a rate limit that named a Retry-After resumes after it, a bounded
      //    number of times in a row (the catch decided which);
      //  - a recycle reset its batch to pending and dropped the conversation.
      // Other quota and auth pauses deliberately do NOT resume — those wait
      // on the user. A zero delay still defers a tick: `session.generatorPromise`
      // is assigned after this chain is built, so resuming inline could be
      // overwritten by that assignment and leave a settled promise blocking
      // every later start.
      if (scheduledResume) {
        resumeGeneratorLater(session, scheduledResume.afterMs, scheduledResume.source, ensureGeneratorRunning);
      }
      if (reason === 'overflow:recycle') {
        resumeGeneratorLater(session, 0, 'overflow-recycle', ensureGeneratorRunning);
      }
      // A queued batch answered with neither XML nor the skip sentinel gets its
      // one more try now, in a fresh generation; ResponseProcessor bounds it to
      // one retry per batch, so this cannot loop.
      if (normalizedReason === 'output_retry') {
        resumeGeneratorLater(session, 0, 'output-retry', ensureGeneratorRunning);
      }
      // A generation that kept drifting off the observation schema was ended
      // after its batches were stored; buffered work continues in a fresh one.
      if (normalizedReason === 'drift') {
        resumeGeneratorLater(session, 0, 'schema-drift', ensureGeneratorRunning);
      }

      // A response stall preserved its claimed batch but, like a recycle, has
      // no later ingest guaranteed to pick it up. Resume after a delay, a
      // bounded number of times in a row; an answered queued-work turn resets
      // the count (#4066).
      if (reason === 'transport:response_stall') {
        const { resume, attempts } = planResponseStallResume(session);
        if (!resume) {
          logger.error('SESSION', `Observer went unanswered ${attempts} times in a row — not resuming until the next captured event`, {
            sessionId: session.sessionDbId,
            consecutiveStalls: attempts,
            maxResumes: MAX_CONSECUTIVE_STALL_RESUMES,
          });
        } else {
          // The delayed retry may hit a quota cooldown and return without
          // starting a generator. Keep this pause eligible for the periodic
          // sweep after the timer fires; ordinary transport pauses still
          // require an explicit retry, and exhausted stalls keep their cap.
          session.pausedReason = 'response_stall';
          const resume = setTimeout(() => {
            session.stallResumeTimer = undefined;
            void ensureGeneratorRunning(session.sessionDbId, 'response-stall')
              .catch(error => {
                logger.error('SESSION', 'Failed to resume the observer after a response stall', {
                  sessionId: session.sessionDbId,
                }, error instanceof Error ? error : new Error(String(error)));
              });
          }, RESPONSE_STALL_RESUME_DELAY_MS);
          resume.unref?.();
          session.stallResumeTimer = resume;
        }
      }
    });
  session.generatorPromise = generatorPromise;
}

/**
 * Book a classified provider failure once, with the provider's own detail
 * (code, message, action, link, request id), so the session-start warning
 * shows the same words as the log line. Returns how long a rate-limited
 * session waits before it resumes on its own, or null when it waits for the
 * next captured event (or the user).
 */
function bookClassifiedFailure(
  session: ActiveSession,
  provider: 'claude' | 'gemini' | 'openrouter',
  error: ClassifiedProviderError,
): number | null {
  let resumeAfterMs: number | null = null;
  switch (error.kind) {
    case 'quota_exhausted':
      // A spent allowance: withhold requests for a cooldown, then let one
      // through to re-probe, instead of one doomed request per event (#3634).
      recordQuotaExhausted(provider, error.message, undefined, undefined, session.observerProfile);
      break;
    case 'auth_invalid':
      // A refused credential fails every request until the user acts; the
      // cooldown stops one wasted request per captured event.
      recordAuthCooldown(provider, error.message, session.observerProfile);
      break;
    case 'rate_limit': {
      // Never a spent allowance. The provider already retried in place, and
      // when it said how long to wait (the gateway envelope always does), the
      // session resumes after that — a bounded number of times in a row.
      // With no Retry-After (OpenRouter's daily free-model limit is such a
      // 429) or once the resumes run out, the limit may last hours: withhold
      // requests behind the breaker instead of resuming into it.
      // On the cmem gateway the resume also draws on the unattended budget it
      // shares with transport and fallback resumes; once that is spent, the
      // breaker takes over here too.
      const plan = error.retryAfterMs !== undefined ? planRateLimitResume(session) : null;
      if (plan?.resume && error.retryAfterMs !== undefined
        && planUnattendedGatewayResume(session, 'rate-limit', isMemoryOnCmemGateway()).resume) {
        resumeAfterMs = Math.min(Math.max(error.retryAfterMs, 0), QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
      } else {
        recordQuotaExhausted(provider, error.message, 'rate_limit', undefined, session.observerProfile);
      }
      break;
    }
  }
  recordObserverFailure(provider, {
    message: error.message,
    kind: error.kind,
    code: error.code,
    action: error.action,
    url: error.url,
    requestId: error.requestId,
  });
  return resumeAfterMs;
}

/**
 * Start the session's generator again after `delayMs`, as the next captured
 * event would. The timer is kept on the session, so the periodic sweep
 * leaves the session to it (a rate limit must not be retried before its
 * Retry-After) and a generator that starts first cancels it.
 */
function resumeGeneratorLater(
  session: ActiveSession,
  delayMs: number,
  source: string,
  ensureGeneratorRunning: GeneratorRunnerDependencies['ensureGeneratorRunning'],
): void {
  clearTimeout(session.scheduledResumeTimer);
  const resume = setTimeout(() => {
    session.scheduledResumeTimer = undefined;
    void ensureGeneratorRunning(session.sessionDbId, source)
      .catch(error => {
        logger.error('SESSION', 'Failed to resume the observer', {
          sessionId: session.sessionDbId,
          source,
        }, error instanceof Error ? error : new Error(String(error)));
      });
  }, delayMs);
  resume.unref?.();
  session.scheduledResumeTimer = resume;
}


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
import {
  MAX_CONSECUTIVE_STALL_RESUMES,
  RESPONSE_STALL_RESUME_DELAY_MS,
  planResponseStallResume,
} from './response-pacer.js';
import { telemetryBuffer } from '../../telemetry/buffer.js';
import { recordObserverFailure } from '../../../shared/observer-health.js';
import { recordClaudeCliSetupRequired } from '../../../shared/dependency-health.js';
import { releaseQuotaProbe, recordQuotaExhausted } from '../../../shared/quota-cooldown.js';
import { isClassified, describeProviderError } from '../provider-errors.js';

export interface GeneratorRunnerDependencies {
  sessionManager: SessionManager;
  sdkAgent: ClaudeProvider;
  geminiAgent: GeminiProvider;
  openRouterAgent: OpenRouterProvider;
  workerService: WorkerService;
  completionHandler: SessionCompletionHandler;
  ensureGeneratorRunning: (sessionDbId: number, source: string) => Promise<void>;
}

/**
 * Collapse session.abortReason onto a closed telemetry enum. The raw value can
 * carry free text after a colon (e.g. 'quota:<provider message>') — never emit
 * it verbatim. Unknown or absent reasons map to 'none'.
 */
function normalizeAbortReason(
  reason: string | null | undefined
): 'idle' | 'shutdown' | 'overflow' | 'restart_guard' | 'quota' | 'provider_switch' | 'none' {
  switch ((reason ?? '').split(':')[0]) {
    case 'idle': return 'idle';
    case 'shutdown': return 'shutdown';
    case 'overflow': return 'overflow';
    case 'restart-guard': return 'restart_guard';
    case 'quota': return 'quota';
    case 'provider_switch': return 'provider_switch';
    default: return 'none';
  }
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
    completionHandler, ensureGeneratorRunning } = deps;
  if (!session) return;

  // A generator is starting, so a pending stall resume has nothing left to do.
  if (session.stallResumeTimer !== undefined) {
    clearTimeout(session.stallResumeTimer);
    session.stallResumeTimer = undefined;
  }

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
  let generatorPromise: Promise<void>;

  generatorPromise = agent.startSession(session, workerService)
    .catch(async error => {
      if (myController.signal.aborted) {
        logger.debug('HTTP', 'Generator catch: ignoring error after abort', { sessionId: session.sessionDbId });
        return;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      if (provider === 'claude' && isClassified(error) && error.kind === 'setup_required') {
        skipGeneratorExitFinalization = true;
        recordClaudeCliSetupRequired(error.message);
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

      // No retry: the generator failed, the in-RAM batch is dropped, and the
      // transcript is the recovery path. The next observation ingest will
      // start a fresh generator via ensureGeneratorRunning.
      //
      // The local error line (full fidelity) and the scrubbed
      // session_compressed rollup are one logical event.
      // No abort_reason here: every site that sets abortReason aborts the
      // controller on its next line, so aborted generators either resolve
      // normally (quota/overflow break) or hit the signal-aborted early
      // return above — this catch only ever sees non-abort rejections.
      if (isClassified(error)) {
        // The single error-level line for a classified provider failure:
        // code, message, action, link, and request id — same words the
        // gateway sent. Pass the rendered string (not the Error): classified
        // errors are user-state (quota/auth/rate-limit), not bugs, so the
        // errorSink/captureException isn't fired for them at all.
        logger.error('SESSION', 'Observer failed', {
          sessionId: session.sessionDbId,
          provider,
          kind: error.kind,
          ...(error.code ? { code: error.code } : {}),
          ...(error.requestId ? { requestId: error.requestId } : {}),
        }, describeProviderError(error));
      } else {
        logger.error('SESSION', 'Generator failed', {
          sessionId: session.sessionDbId,
          provider,
          error: errorMsg,
        }, error);
      }
      // Trial-expiry fallback (plan 2026-08-26 Phase 6): a terminal quota/key
      // rejection from the cmem gateway is the promised automatic switch to
      // the Anthropic plan, not an outage — record the fallback marker (the
      // next dispatch returns 'claude') and keep it OUT of the observer-health
      // ledger so the scary session-start outage warning never fires for it.
      //
      // The quota breaker is NESTED in the else, not stacked ahead of this
      // branch. Stacking them would run two cooldowns over one event with
      // disagreeing periods (15 min here, 30 min there) and open a window
      // where memory neither uses the gateway nor falls back. The gateway's
      // own fallback marker IS the breaker on that path.
      if (provider === 'openrouter' && isClassified(error) && recordCmemFallbackIfEligible(error)) {
        logger.warn('SESSION', 'cmem gateway key is no longer funded; memory falls back to the Anthropic plan provider', {
          sessionId: session.sessionDbId,
          kind: error.kind,
          ...(error.code ? { code: error.code } : {}),
        });
      } else {
        // Observer-health ledger: repeated generator failures mean observations
        // are being dropped — session-start context warns the user via this.
        // Classified errors carry the structured detail (code/action/link/
        // request id) so the warning shows the same words as the log line.
        // A structured quota refusal arms the breaker, so the next observation
        // does not immediately buy the same refusal again (#3634).
        if (isClassified(error) && error.kind === 'quota_exhausted') {
          recordQuotaExhausted(provider, error.message);
        }
        recordObserverFailure(provider, isClassified(error)
          ? { message: error.message, kind: error.kind, code: error.code, action: error.action, url: error.url, requestId: error.requestId }
          : errorMsg);
      }
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
      // Quota surfaced as assistant prose aborts here rather than throwing, so
      // it must arm the breaker too — otherwise the prose path keeps the
      // per-observation request storm the classified path no longer has.
      if (normalizeAbortReason(reason) === 'quota') {
        const quotaMessage = 'Provider reported the inference allowance exhausted';
        recordQuotaExhausted(provider, quotaMessage, reason?.split(':')[1]);
        // Quota returned as assistant prose never throws, so it never reaches
        // the .catch above and never armed the health ledger. Without this the
        // session-start warning is structurally blind to an entire outage
        // class: the allowance is spent, no observation will ever store, and
        // the user is told nothing.
        recordObserverFailure(provider, { message: quotaMessage, kind: 'quota_exhausted' });
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
          abort_reason: normalizeAbortReason(reason),
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
      });

      // A recycle is the one abort that should resume on its own. The batch
      // was reset to pending and the conversation dropped; without this the
      // work waits for the next captured tool call, so the final observation
      // of a session is stranded when none arrives. Quota and auth pauses
      // deliberately do NOT resume — those wait on the user.
      if (reason === 'overflow:recycle') {
        // Deferred a tick: `session.generatorPromise` is assigned after this
        // chain is built, so resuming inline could be overwritten by that
        // assignment and leave a settled promise blocking every later start.
        const resume = setTimeout(() => {
          void ensureGeneratorRunning(session.sessionDbId, 'overflow-recycle')
            .catch(error => {
              logger.error('SESSION', 'Failed to resume the observer after recycling its conversation', {
                sessionId: session.sessionDbId,
              }, error instanceof Error ? error : new Error(String(error)));
            });
        }, 0);
        resume.unref?.();
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

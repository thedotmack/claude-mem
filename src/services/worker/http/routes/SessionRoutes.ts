
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ingestObservation } from '../shared.js';
import { validateBody } from '../middleware/validateBody.js';
import { requireLocalhost } from '../middleware.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTags, isInternalProtocolPayload } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { ClaudeProvider } from '../../ClaudeProvider.js';
import { GeminiProvider } from '../../GeminiProvider.js';
import { OpenRouterProvider } from '../../OpenRouterProvider.js';
import { getSelectedProvider, recordCmemFallbackIfEligible, releaseCmemGatewayProbe, selectProviderForGenerator } from '../../provider-dispatch.js';
import type { WorkerService } from '../../../worker-service.js';
import type { ActiveSession } from '../../../worker-types.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, ensureObserverSessionsDir } from '../../../../shared/paths.js';
import { getProjectContext, isProjectKeySource } from '../../../../utils/project-name.js';
import { handleGeneratorExit } from '../../session/GeneratorExitHandler.js';
import {
  MAX_CONSECUTIVE_STALL_RESUMES,
  RESPONSE_STALL_RESUME_DELAY_MS,
  planRateLimitResume,
  planResponseStallResume,
} from '../../session/response-pacer.js';
import { telemetryBuffer } from '../../../telemetry/buffer.js';
import { captureEvent } from '../../../telemetry/telemetry.js';
import { firstPartySkillFromSlashPrompt } from '../../../telemetry/skill-id.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { observerUsageLogFields } from '../../observer-usage.js';
import { USER_PROMPT_DEDUPE_WINDOW_MS } from '../../../../shared/user-prompts.js';
import {
  CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS,
  clearDependencyStatus,
  getDependencyStatus,
  isDependencyStatusInCooldown,
  recordClaudeCliSetupRequired,
  recordClaudeSetupRequired,
} from '../../../../shared/dependency-health.js';
import { findClaudeExecutable, isClaudeExecutableUnspawnable } from '../../../../shared/find-claude-executable.js';
import { recordObserverFailure } from '../../../../shared/observer-health.js';
import {
  tryAdmitQuotaProbe,
  releaseQuotaProbe,
  recordAuthCooldown,
  recordQuotaExhausted,
  getQuotaCooldown,
  isQuotaCooldownActive,
  cooldownAppliesToCurrentAccount,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
} from '../../../../shared/quota-cooldown.js';
import { DEADLINE_EXCEEDED_CODE, isClassified, describeProviderError, type ClassifiedProviderError } from '../../provider-errors.js';
import { classifyClaudeError } from '../../ClaudeProvider.js';
import { isSessionParkedForSlot } from '../../../../supervisor/process-registry.js';
import {
  canAttemptClaudeCliSelfHeal,
  recordClaudeCliSelfHealAttempt,
  clearClaudeCliSelfHealAttempts,
  claudeCliSelfHealAttemptsInWindow,
  SELF_HEAL_MAX_ATTEMPTS,
} from '../../stale-spawn-recovery.js';
import type { TelegramWrapupFormatterInput } from '../../../integrations/TelegramWrapupNotifier.js';

const MAX_USER_PROMPT_BYTES = 256 * 1024;

/**
 * Collapse session.abortReason onto a closed telemetry enum. The raw value can
 * carry free text after a colon (e.g. 'quota:<provider message>') — never emit
 * it verbatim. Unknown or absent reasons map to 'none'.
 */
function normalizeAbortReason(
  reason: string | null | undefined
): 'idle' | 'shutdown' | 'overflow' | 'restart_guard' | 'quota' | 'rate_limit' | 'auth' | 'provider_switch' | typeof DEADLINE_EXCEEDED_CODE | 'none' {
  // The one transport pause that is ours: a request abandoned at the LLM
  // deadline, possibly already billed upstream. Every other transport pause
  // stays 'none', as before.
  if (reason === `transport:${DEADLINE_EXCEEDED_CODE}`) return DEADLINE_EXCEEDED_CODE;
  switch ((reason ?? '').split(':')[0]) {
    case 'idle': return 'idle';
    case 'shutdown': return 'shutdown';
    case 'overflow': return 'overflow';
    case 'restart-guard': return 'restart_guard';
    case 'quota': return 'quota';
    case 'rate_limit': return 'rate_limit';
    case 'auth': return 'auth';
    case 'provider_switch': return 'provider_switch';
    default: return 'none';
  }
}

export class SessionRoutes extends BaseRouteHandler {
  // #2756 round 3: ensureGeneratorRunning is called from independent HTTP
  // request handlers (observation ingest, /summarize, /init — see
  // shared.ts:138 and this file's own callers below), so two calls for the
  // SAME sessionDbId can genuinely run concurrently. Both branches of the
  // method below have an async gap — an `await` between reading
  // `session.generatorPromise`/`session.currentProvider` and the eventual
  // `startGeneratorWithProvider` call that reassigns them — during which a
  // second concurrent call sees stale state and starts its own generator,
  // producing two live generators for one session. This map serializes
  // ensureGeneratorRunning calls per sessionDbId (a promise-chained mutex) so
  // only one call's body runs at a time; calls for different sessionDbIds
  // remain fully concurrent. See ensureGeneratorRunningLocked for the actual
  // logic this now gates.
  private ensureGeneratorLocks = new Map<number, Promise<void>>();

  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: ClaudeProvider,
    private geminiAgent: GeminiProvider,
    private openRouterAgent: OpenRouterProvider,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService,
    private completionHandler: SessionCompletionHandler,
  ) {
    super();
    this.sessionManager.setTelegramWrapupFormatter?.(this.formatTelegramWrapup);
  }

  /**
   * A worker process self-heals the stale-Claude-spawn wedge at most once: the
   * restart replaces this process, so concurrent sessions hitting the same wedge
   * must not each burn a slot in the per-generation persistent budget.
   */
  private claudeSelfHealTriggered = false;

  /**
   * When the Claude CLI is present on disk but this worker process can no longer
   * spawn it (ENOENT after a CLI auto-update swapped the binary underneath a
   * long-running process), an in-process re-probe can never recover — only a
   * fresh process can. Self-restart the worker via the successor-handoff path,
   * bounded by a cross-process-persistent budget so a genuinely broken install
   * cannot thrash. Returns true when a restart was triggered.
   */
  private maybeSelfHealStaleClaudeSpawn(error: unknown, source: string, sessionDbId: number): boolean {
    const cause = isClassified(error) ? (error as ClassifiedProviderError).cause : undefined;
    const unspawnable = isClaudeExecutableUnspawnable(error) || isClaudeExecutableUnspawnable(cause);
    if (!unspawnable) return false;

    // Restart already scheduled by an earlier session in this process — the
    // successor will re-resolve the CLI; do not record another attempt.
    if (this.claudeSelfHealTriggered) return true;

    if (!canAttemptClaudeCliSelfHeal()) {
      logger.warn('SESSION', 'Claude CLI present but unspawnable; self-heal restart budget exhausted — leaving in setup_required (restart claude-mem manually / verify the CLI)', {
        sessionId: sessionDbId,
        source,
        attemptsInWindow: claudeCliSelfHealAttemptsInWindow(),
        maxAttempts: SELF_HEAL_MAX_ATTEMPTS,
      });
      return false;
    }

    const attempt = recordClaudeCliSelfHealAttempt();
    logger.warn('SESSION', 'Claude CLI present on disk but unspawnable from this worker (stale process after CLI auto-update) — self-restarting to recover', {
      sessionId: sessionDbId,
      source,
      selfHealAttempt: attempt,
      maxAttempts: SELF_HEAL_MAX_ATTEMPTS,
    });
    this.claudeSelfHealTriggered = true;
    void this.workerService.shutdown('restart');
    return true;
  }

  private formatTelegramWrapup = async (input: TelegramWrapupFormatterInput): Promise<string> => {
    const activeSession = this.sessionManager.getSession(input.sessionDbId);
    const selection = activeSession?.currentProvider
      ? { provider: activeSession.currentProvider, gatewayProbeClaimId: null }
      : selectProviderForGenerator();
    const activeModelId = activeSession?.currentProvider ? activeSession.lastModelId : undefined;

    try {
      switch (selection.provider) {
        case 'gemini':
          return await this.geminiAgent.formatTelegramWrapup(input, activeModelId);
        case 'openrouter':
          return await this.openRouterAgent.formatTelegramWrapup(input, activeModelId);
        default:
          return await this.sdkAgent.formatTelegramWrapup(input, activeModelId);
      }
    } catch (error) {
      // A wrap-up is a gateway request like any other: a terminal rejection
      // records the fallback, and when this wrap-up holds the post-window
      // re-probe claim, its failure keeps memory on Claude.
      if (selection.provider === 'openrouter') {
        recordCmemFallbackIfEligible(error, selection.gatewayProbeClaimId);
      }
      throw error;
    } finally {
      releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
    }
  };

  /** Schedule retries through the normal provider gates and per-session mutex.
   * The count is attempts scheduled, not generators admitted by those gates.
   *
   * The automatic sweep is paced by the provider's quota breaker (read-only):
   * nothing is scheduled while the breaker withholds requests, since every
   * attempt would only log a skip (#4127 counted 159 of those). Once the window
   * elapses, one session per tick goes through to carry the recovery probe; the
   * rest follow after that probe succeeds and clears the breaker. A breaker
   * armed under another Claude account paces nothing: admission would drop it
   * and admit, so holding this account's backlog behind it only delays it.
   * The operator retry (`POST /api/processing`) is not paced.
   */
  public resumePendingSessions(source: string, includeOperatorOnly: boolean = false): number {
    let sessionIds = this.sessionManager.getResumableSessionIds(includeOperatorOnly);
    if (!includeOperatorOnly && sessionIds.length > 0) {
      const provider = getSelectedProvider();
      const cooldown = getQuotaCooldown(provider);
      if (cooldown && cooldownAppliesToCurrentAccount(cooldown)) {
        if (isQuotaCooldownActive(provider)) return 0;
        sessionIds = sessionIds.slice(0, 1);
      }
    }
    for (const sessionDbId of sessionIds) {
      void this.ensureGeneratorRunning(sessionDbId, source).catch((error: unknown) => {
        logger.warn('SESSION', 'Failed to resume buffered session', { sessionId: sessionDbId, source },
          error instanceof Error ? error : new Error(String(error)));
      });
    }
    return sessionIds.length;
  }

  public ensureGeneratorRunning(sessionDbId: number, source: string): Promise<void> {
    const priorTail = this.ensureGeneratorLocks.get(sessionDbId) ?? Promise.resolve();
    // .catch(() => {}) on the PRIOR tail only: one call's rejection must
    // never jam the queue for the next call on this session. `tail` itself
    // is left un-caught here so its own rejection still propagates to ITS
    // caller (the caller of ensureGeneratorRunning gets back `tail`).
    const tail: Promise<void> = priorTail
      .catch(() => {})
      .then(() => this.ensureGeneratorRunningLocked(sessionDbId, source));

    this.ensureGeneratorLocks.set(sessionDbId, tail);

    // Drop the map entry once this call is the last one queued, so the map
    // doesn't grow forever for sessions that stop calling in. Identity
    // check against `tail` itself: if a later call has already replaced
    // this entry with its own tail, leave that one in place. The `.catch`
    // here is only to stop bun/node from reporting an unhandled rejection
    // on this cleanup-only branch — it does not affect the `tail` promise
    // returned below, which callers still see reject normally.
    tail.catch(() => {}).finally(() => {
      if (this.ensureGeneratorLocks.get(sessionDbId) === tail) {
        this.ensureGeneratorLocks.delete(sessionDbId);
      }
    });

    return tail;
  }

  private async ensureGeneratorRunningLocked(sessionDbId: number, source: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    // Nothing is buffered, so a generator would only open with its INIT turn
    // and idle out: one paid request per user prompt, including prompts that
    // never use a tool (#3454). Gated BEFORE provider selection, so this path
    // never takes the single cmem-gateway re-probe (or a quota probe) that it
    // would then have to release. The first observation or summarize enqueues
    // work and starts the generator, INIT turn included, through this same
    // method. Resume sources (overflow-recycle, response-stall, rate-limit,
    // cmem-fallback, the periodic sweep) pass the same gate: with nothing
    // buffered there is nothing to resume.
    if (this.sessionManager.getMessageBuffer().getPendingCount(sessionDbId) === 0) {
      logger.debug('SESSION', 'Skipping generator start with an empty queue', { sessionId: sessionDbId, source });
      return;
    }

    // The claiming variant: this path is about to SEND, so it must take the
    // single gateway re-probe rather than merely reading the clock.
    const selection = selectProviderForGenerator();
    const selectedProvider = selection.provider;

    if (!session.generatorPromise) {
      // Overflow breaker (#3800). Recycling twice without producing a
      // conversation that fits means a restart can only abort on the same
      // budget check — one spawn and one abort per captured tool call. Withhold
      // restarts for a cooldown, then let one through to re-probe.
      if (session.overflowPausedUntilMs && Date.now() < session.overflowPausedUntilMs) {
        logger.warn('SESSION', 'Skipping generator start while the observer overflow cooldown is active', {
          sessionId: sessionDbId,
          source,
          retryInMs: session.overflowPausedUntilMs - Date.now(),
        });
        releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
        return;
      }
      if (session.overflowPausedUntilMs) {
        // Cooldown elapsed: clear the gate and the recycle debt so the probe
        // starts from a clean slate rather than tripping the exhausted branch
        // on its first budget check.
        session.overflowPausedUntilMs = undefined;
        session.consecutiveContextOverflows = 0;
      }

      if (selectedProvider === 'claude') {
        const claudeStatus = getDependencyStatus('claude_cli');
        if (claudeStatus?.kind === 'setup_required') {
          if (isDependencyStatusInCooldown(claudeStatus, CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS)) {
            logger.warn('SESSION', 'Skipping Claude generator start until setup is repaired', {
              sessionId: sessionDbId,
              source,
              dependency: claudeStatus.dependency,
              status: claudeStatus.kind,
              message: claudeStatus.message,
            });
            releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
            return;
          }

          try {
            findClaudeExecutable('SDK');
            clearDependencyStatus('claude_cli');
            clearClaudeCliSelfHealAttempts();
            logger.info('SESSION', 'Claude setup dependency repaired; resuming generator start', {
              sessionId: sessionDbId,
              source,
            });
          } catch (error) {
            if (this.maybeSelfHealStaleClaudeSpawn(error, source, sessionDbId)) {
              // The self-heal restart can be delayed or fail to hand off, and a
              // second session hitting the already-triggered flag returns here
              // while the first restart is still pending — in any of those
              // windows this worker keeps running. No generator is started to
              // carry the claim, so release it now like every other early
              // return in this block; otherwise the gateway probe stays
              // in-flight and suppresses later gateway checks in a worker that
              // survived its own restart trigger.
              releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
              return;
            }
            const err = error instanceof Error ? error : new Error(String(error));
            const classified = classifyClaudeError(error);
            if (classified.kind === 'setup_required') {
              recordClaudeCliSetupRequired(classified.message);
            }
            logger.warn('SESSION', 'Claude setup dependency still unavailable after cooldown', {
              sessionId: sessionDbId,
              source,
              error: classified.message,
            }, err);
            releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
            return;
          }
        }

        // An unusable observer working directory has its own recheck (#4117):
        // until the directory can be created, a start only repeats the slot
        // wait, the keychain read and the same failure. Creating it is the
        // whole probe.
        if (getDependencyStatus('observer_dir')) {
          try {
            ensureObserverSessionsDir();
          } catch (error) {
            logger.warn('SESSION', 'Skipping Claude generator start until the observer working directory is usable', {
              sessionId: sessionDbId,
              source,
              error: error instanceof Error ? error.message : String(error),
            });
            releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
            return;
          }
          clearDependencyStatus('observer_dir');
          logger.info('SESSION', 'Observer working directory repaired; resuming generator start', {
            sessionId: sessionDbId,
            source,
          });
        }
      }
      await this.admitAndStartGenerator(session, sessionDbId, selectedProvider, source, selection.gatewayProbeClaimId);
      return;
    }

    // #2756: a generator that never acquired its concurrency slot (still
    // parked in waitForSlot) can wait indefinitely — it never idles-out,
    // because the idle monitor only runs once the generator loop is
    // consuming messages. Abort the parked wait and restart with the new
    // provider immediately instead of leaving it stuck. A generator that HAS
    // acquired its slot (mid-response) is left alone — falls through to the
    // log-only "switch after it finishes" path below, unchanged.
    if (session.currentProvider && session.currentProvider !== selectedProvider && isSessionParkedForSlot(sessionDbId)) {
      // Defensive re-guard: `session` is already narrowed non-null by the
      // early return above, but this branch spans a 3-operand `&&` plus a
      // trailing function call before any property access — re-asserting
      // the guard here costs nothing and removes any dependency on TS
      // control-flow narrowing surviving that shape across the awaits below.
      if (!session) return;
      logger.info('SESSION', 'Provider changed while generator parked waiting for a slot; aborting the wait to switch now', {
        sessionId: sessionDbId,
        currentProvider: session.currentProvider,
        selectedProvider,
        historyLength: session.conversationHistory.length
      });

      const oldGeneratorPromise = session.generatorPromise;
      session.abortReason = 'provider_switch';
      session.abortController.abort();

      await this.admitAndStartGenerator(
        session, sessionDbId, selectedProvider, source, selection.gatewayProbeClaimId, oldGeneratorPromise,
      );
      return;
    }

    // A generator is already running, so this call never sends and must not
    // keep the gateway re-probe it claimed on the way in.
    releaseCmemGatewayProbe(selection.gatewayProbeClaimId);

    if (session.currentProvider && session.currentProvider !== selectedProvider) {
      logger.info('SESSION', `Provider changed, will switch after current generator finishes`, {
        sessionId: sessionDbId,
        currentProvider: session.currentProvider,
        selectedProvider,
        historyLength: session.conversationHistory.length
      });
      // Let current generator finish naturally, next one will use new provider.
      // The buffered queue carries over; the next generator opens a new
      // generation seeded from this session's memory (#3800, #3479).
    }
  }

  /**
   * Claim the quota probe (if the breaker permits it) and start a generator
   * for `selectedProvider`. Shared by the fresh-start path above and the
   * #2756 parked-generator provider-switch path (which is itself a fresh
   * start for the newly-selected provider, just triggered from the
   * "already running" branch instead of "no generator yet").
   */
  private async admitAndStartGenerator(
    session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>,
    sessionDbId: number,
    selectedProvider: 'claude' | 'gemini' | 'openrouter',
    source: string,
    gatewayProbeClaimId: number | null,
    /** The parked generator a provider switch is replacing, if any. */
    previousGenerator: Promise<void> | null = null,
  ): Promise<void> {
    let quotaProbeClaimId: number | null = null;
    try {
      // Must fully await the OLD generator's .catch().finally() chain (which
      // runs handleGeneratorExit) before starting a new one: handleGeneratorExit
      // nulls session.generatorPromise/currentProvider unconditionally with no
      // identity check, so racing this would let the old generator's async
      // cleanup stomp the freshly-started generator's state.
      if (previousGenerator) {
        await previousGenerator;
      }

      // Quota breaker (#3634). Without this, an exhausted allowance produced one
      // doomed request per captured tool call for the rest of the billing cycle:
      // the generator exits on the refusal, and the next observation starts a
      // fresh one that earns the same refusal. Withhold requests for a cooldown,
      // then let exactly one through to re-probe.
      // Claim the probe rather than merely reading the clock: every live session
      // sees the window elapse at the same instant, so a bare check would let
      // them all through together.
      const admission = tryAdmitQuotaProbe(selectedProvider);
      if (!admission.admitted) {
        // This run is not starting, so it must not hold the gateway re-probe.
        releaseCmemGatewayProbe(gatewayProbeClaimId);
        const cooldown = getQuotaCooldown(selectedProvider);
        logger.warn('SESSION', 'Skipping generator start while the provider cooldown is active', {
          sessionId: sessionDbId,
          source,
          provider: selectedProvider,
          ...(cooldown?.cause ? { cause: cooldown.cause } : {}),
          ...(cooldown?.window ? { window: cooldown.window } : {}),
          probeInFlight: cooldown?.probeInFlightSinceMs !== null,
          retryInMs: cooldown
            ? Math.max(0, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - (Date.now() - cooldown.armedAtMs))
            : 0,
        });
        return;
      }
      quotaProbeClaimId = admission.claimId;

      await this.applyTierRouting(session);
      // The claim travels with the run that took it: only that run may release
      // it, or an earlier generator's exit would clear a later session's probe.
      await this.startGeneratorWithProvider(
        session, selectedProvider, source, quotaProbeClaimId, gatewayProbeClaimId,
      );
    } catch (error) {
      // Neither claim may outlive a run that never started, or it wedges its
      // probe shut until it goes stale. A generator that did start releases
      // its own on exit; releasing again is a no-op, scoped to the claim id.
      releaseQuotaProbe(selectedProvider, quotaProbeClaimId);
      releaseCmemGatewayProbe(gatewayProbeClaimId);
      throw error;
    }
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
  private recordDeadlineExpiry(
    provider: 'claude' | 'gemini' | 'openrouter',
    session: ActiveSession,
    error: unknown,
  ): void {
    if (!isClassified(error) || error.code !== DEADLINE_EXCEEDED_CODE) return;
    if (this.sessionManager.getSession(session.sessionDbId) !== session) return;
    recordObserverFailure(provider, {
      message: error.message,
      kind: error.kind,
      code: error.code,
      action: error.action,
    });
  }

  private async startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    provider: 'claude' | 'gemini' | 'openrouter',
    source: string,
    /** The quota probe this run claimed, or null when it was admitted without one. */
    quotaProbeClaimId: number | null,
    /** The cmem-gateway re-probe this run claimed, or null when it took none. */
    gatewayProbeClaimId: number | null = null,
  ): Promise<void> {
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

    const agent = provider === 'openrouter' ? this.openRouterAgent : (provider === 'gemini' ? this.geminiAgent : this.sdkAgent);
    const agentName = provider === 'openrouter' ? 'OpenRouter' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');

    const actualQueueDepth = this.sessionManager.getMessageBuffer().getPendingCount(session.sessionDbId);

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

    generatorPromise = agent.startSession(session, this.workerService)
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
          this.maybeSelfHealStaleClaudeSpawn(error, source, session.sessionDbId);
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
          scheduledResume = { afterMs: 0, source: 'cmem-fallback' };
          // The gateway's words and request id, which its copy asks users to
          // quote to support.
          logger.warn('SESSION', 'cmem gateway is not serving this account; memory runs on the Anthropic plan provider', {
            sessionId: session.sessionDbId,
            ...(classified ? { kind: classified.kind } : {}),
            ...(classified?.code ? { code: classified.code } : {}),
            ...(classified?.requestId ? { requestId: classified.requestId } : {}),
          }, classified ? describeProviderError(classified) : errorMsg);
        } else if (classified?.kind === 'transient' && myController.signal.aborted) {
          this.recordDeadlineExpiry(provider, session, classified);
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
          const resumeAfterMs = this.bookClassifiedFailure(session, provider, classified);
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
          sessionManager: this.sessionManager,
          completionHandler: this.completionHandler,
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
          this.resumeGeneratorLater(session, scheduledResume.afterMs, scheduledResume.source);
        }
        if (reason === 'overflow:recycle') {
          this.resumeGeneratorLater(session, 0, 'overflow-recycle');
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
              void this.ensureGeneratorRunning(session.sessionDbId, 'response-stall')
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
  private bookClassifiedFailure(
    session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>,
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
        const plan = error.retryAfterMs !== undefined ? planRateLimitResume(session) : null;
        if (plan?.resume && error.retryAfterMs !== undefined) {
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
  private resumeGeneratorLater(
    session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>,
    delayMs: number,
    source: string,
  ): void {
    clearTimeout(session.scheduledResumeTimer);
    const resume = setTimeout(() => {
      session.scheduledResumeTimer = undefined;
      void this.ensureGeneratorRunning(session.sessionDbId, source)
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

  setupRoutes(app: express.Application): void {
    // Operator repair route: it starts generators and retries auth/transport
    // pauses that the automatic sweep leaves alone, so it is localhost-only
    // like the other admin routes.
    app.post(
      '/api/processing',
      requireLocalhost,
      validateBody(SessionRoutes.processingSchema),
      this.handleProcessing.bind(this)
    );
    app.post(
      '/api/sessions/init',
      validateBody(SessionRoutes.sessionInitByClaudeIdSchema),
      this.handleSessionInitByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/observations',
      validateBody(SessionRoutes.observationsByClaudeIdSchema),
      this.handleObservationsByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/summarize',
      validateBody(SessionRoutes.summarizeByClaudeIdSchema),
      this.handleSummarizeByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/session-end',
      validateBody(SessionRoutes.sessionEndSchema),
      this.handleSessionEnd.bind(this)
    );
  }

  private static readonly processingSchema = z.object({
    isProcessing: z.boolean(),
  });

  private handleProcessing = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // Legacy callers request false to unstick processing. There is no global
    // processing flag to reset: retry existing buffered sessions instead.
    const scheduledSessions = req.body.isProcessing ? 0 : this.resumePendingSessions('processing-api', true);
    const queueDepth = this.sessionManager.getTotalQueueDepth();
    res.json({
      status: 'ok',
      isProcessing: queueDepth > 0,
      queueDepth,
      activeSessions: this.sessionManager.getActiveSessionCount(),
      scheduledSessions,
    });
  });

  private static readonly sessionInitByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    project: z.string().optional(),
    prompt: z.string().optional(),
    platformSource: z.string().optional(),
    customTitle: z.string().optional(),
    // The checkout `project` was resolved from, and how (gate P1-2).
    cwd: z.string().optional(),
    projectKeySource: z.string().optional(),
  }).passthrough();

  private static readonly observationsByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    tool_name: z.string().min(1),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    cwd: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    platformSource: z.string().optional(),
    tool_use_id: z.string().optional(),
    toolUseId: z.string().optional(),
    // Receipt join keys (frozen 2026-09-06). Pure pass-through onto tool_uses;
    // Claude-Mem never derives them and stores no cost field of its own.
    or_generation_id: z.string().optional(),
    orGenerationId: z.string().optional(),
    or_session_id: z.string().optional(),
    orSessionId: z.string().optional(),
  }).passthrough();

  private static readonly summarizeByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    last_assistant_message: z.string().optional(),
    agentId: z.string().optional(),
    platformSource: z.string().optional(),
    observedModel: z.string().min(1).max(200).optional(),
    observedBilling: z.string().min(1).max(40).optional(),
  }).passthrough();

  private static readonly sessionEndSchema = z.object({
    contentSessionId: z.string().min(1),
    platformSource: z.string().optional(),
    reason: z.string().optional(),
    cwd: z.string().optional(),
  }).passthrough();

  private handleObservationsByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const {
      contentSessionId,
      tool_name,
      tool_input,
      tool_response,
      cwd,
      agentId,
      agentType,
      tool_use_id,
      toolUseId,
      or_generation_id,
      orGenerationId,
      or_session_id,
      orSessionId,
    } = req.body;
    const platformSource = this.getPlatformSourceFromRequest(req);

    const result = await ingestObservation({
      contentSessionId,
      toolName: tool_name,
      toolInput: tool_input,
      toolResponse: tool_response,
      cwd,
      platformSource,
      agentId,
      agentType,
      toolUseId: typeof tool_use_id === 'string' ? tool_use_id : (typeof toolUseId === 'string' ? toolUseId : undefined),
      orGenerationId: typeof or_generation_id === 'string' ? or_generation_id : (typeof orGenerationId === 'string' ? orGenerationId : undefined),
      orSessionId: typeof or_session_id === 'string' ? or_session_id : (typeof orSessionId === 'string' ? orSessionId : undefined),
    });

    if (!result.ok) {
      res.status(result.status ?? 500).json({ stored: false, reason: result.reason });
      return;
    }

    if ('status' in result && result.status === 'skipped') {
      res.json({ status: 'skipped', reason: result.reason });
      return;
    }

    res.json({ status: 'queued' });
  });

  private handleSummarizeByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId, last_assistant_message, agentId, observedModel, observedBilling } = req.body;
    const platformSource = this.getPlatformSourceFromRequest(req);

    if (agentId) {
      res.json({ status: 'skipped', reason: 'subagent_context' });
      return;
    }

    const store = this.dbManager.getSessionStore();

    const sessionDbId = store.createSDKSession(contentSessionId, '', '', undefined, platformSource);

    if (observedModel || observedBilling) {
      store.setSessionObservedMetadata(sessionDbId, observedModel, observedBilling);
      const active = this.sessionManager.getSession(sessionDbId);
      if (active) {
        if (observedModel) active.observedModel = observedModel;
        if (observedBilling) active.observedBilling = observedBilling;
      }
    }

    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId);

    const privacy = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'summarize',
      sessionDbId
    );
    if (!privacy.allow) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    const cleanedLastAssistantMessage = last_assistant_message
      ? stripMemoryTags(String(last_assistant_message))
      : last_assistant_message;
    await this.sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage);

    await this.ensureGeneratorRunning(sessionDbId, 'summarize');

    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  private handleSessionEnd = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId } = req.body;
    const platformSource = this.getPlatformSourceFromRequest(req);
    const store = this.dbManager.getSessionStore();
    const sessionDbId = store.findSessionDbIdByContentSessionId(contentSessionId, platformSource);

    if (sessionDbId === null) {
      res.json({ status: 'unknown_session' });
      return;
    }

    await this.sessionManager.requestSessionWrapup(sessionDbId);
    res.json({ status: 'accepted' });
  });

  private handleSessionInitByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId } = req.body;

    const project = req.body.project || 'unknown';
    const rawPrompt = typeof req.body.prompt === 'string' ? req.body.prompt : undefined;
    const platformSource = this.getPlatformSourceFromRequest(req);
    const customTitle = req.body.customTitle || undefined;

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HTTP', 'session-init: skipping internal protocol payload before session creation', { contentSessionId });
      res.json({ skipped: true, reason: 'internal_protocol' });
      return;
    }

    const slashSkillId = firstPartySkillFromSlashPrompt(rawPrompt);
    if (slashSkillId) {
      captureEvent('skill_invoked', {
        skill_id: slashSkillId,
        skill_source: 'first_party',
        skill_trigger: 'prompt',
        ide: platformSource,
      });
    }

    let prompt = rawPrompt || '[media prompt]';

    const promptByteLength = Buffer.byteLength(prompt, 'utf8');
    if (promptByteLength > MAX_USER_PROMPT_BYTES) {
      logger.warn('HTTP', 'SessionRoutes: oversized prompt truncated at session-init boundary', {
        project,
        contentSessionId,
        promptByteLength,
        maxBytes: MAX_USER_PROMPT_BYTES,
        preview: prompt.slice(0, 200)
      });
      const buf = Buffer.from(prompt, 'utf8');
      let end = MAX_USER_PROMPT_BYTES;
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
      prompt = buf.subarray(0, end).toString('utf8');
    }

    logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
      contentSessionId,
      project,
      platformSource,
      prompt_length: prompt?.length,
      customTitle
    });

    const store = this.dbManager.getSessionStore();

    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle, platformSource);

    // The checkout the hook resolved `project` from, and how it derived it, so a
    // session that never reports an observation still leaves evidence for
    // worktree adoption (gate P1-2). An unknown key source is not recorded as
    // anything: the next observation's ingest records the checkout itself.
    const checkoutCwd = typeof req.body.cwd === 'string' ? req.body.cwd : '';
    if (checkoutCwd.trim() && isProjectKeySource(req.body.projectKeySource)) {
      store.setSessionCwd(sessionDbId, checkoutCwd, req.body.projectKeySource);
    }

    const dbSession = store.getSessionById(sessionDbId);
    const isNewSession = !dbSession?.memory_session_id;
    logger.info('SESSION', `CREATED | contentSessionId=${contentSessionId} → sessionDbId=${sessionDbId} | isNew=${isNewSession} | project=${project}`, {
      sessionId: sessionDbId
    });

    const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId);
    const promptNumber = currentCount + 1;

    const memorySessionId = dbSession?.memory_session_id || null;
    if (promptNumber > 1) {
      logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
    } else {
      logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
    }

    const cleanedPrompt = stripMemoryTags(prompt);

    if (!cleanedPrompt || cleanedPrompt.trim() === '') {
      logger.debug('HOOK', 'Session init - prompt entirely private', {
        sessionId: sessionDbId,
        promptNumber,
        originalLength: prompt.length
      });

      res.json({
        sessionDbId,
        promptNumber,
        skipped: true,
        reason: 'private'
      });
      return;
    }

    const duplicatePrompt = store.findRecentDuplicateUserPrompt(
      contentSessionId,
      cleanedPrompt,
      USER_PROMPT_DEDUPE_WINDOW_MS,
      sessionDbId
    );

    if (duplicatePrompt) {
      const contextInjected = this.sessionManager.getSession(sessionDbId) !== undefined;
      logger.debug('SESSION', 'Duplicate user prompt skipped', {
        sessionId: sessionDbId,
        promptNumber: duplicatePrompt.prompt_number,
        duplicatePromptId: duplicatePrompt.id,
        contextInjected
      });

      res.json({
        sessionDbId,
        promptNumber: duplicatePrompt.prompt_number,
        skipped: true,
        reason: 'duplicate',
        contextInjected
      });
      return;
    }

    // A prompt this route ACCEPTS on a row a previous end already completed
    // means the session carried on, so put it back to active and let the next
    // end stamp the real completion time (#4080).
    //
    // After the privacy and duplicate gates, not before them. Both of those
    // return early without saving a prompt or starting a generator, so a
    // reopen above them would clear the completion of a session nothing is
    // going to finalize again — a retry of an already-saved prompt would leave
    // the row 'active' for good, which is the bug in the other direction
    // (#2373). Only this route reopens at all: the observation and summarize
    // routes can carry trailing traffic from the turn that just ended, where
    // 'completed' is the truth.
    store.reopenCompletedSession(sessionDbId);

    store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt, sessionDbId);

    // Fire-and-forget cloud sync nudge, beside the write itself so every
    // saved prompt nudges — including cursor sessions, which skip the
    // non-cursor branch below entirely.
    this.dbManager.getCloudSync()?.notify();

    const contextInjected = this.sessionManager.getSession(sessionDbId) !== undefined;

    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber,
      contextInjected
    });

    if (platformSource !== 'cursor') {
      const sdkPrompt = cleanedPrompt.startsWith('/') ? cleanedPrompt.substring(1) : cleanedPrompt;
      const session = this.sessionManager.initializeSession(sessionDbId, sdkPrompt, promptNumber, project);

      const latestPrompt = store.getLatestUserPrompt(session.contentSessionId, sessionDbId);

      if (latestPrompt) {
        this.eventBroadcaster.broadcastNewPrompt({
          id: latestPrompt.id,
          content_session_id: latestPrompt.content_session_id,
          project: latestPrompt.project,
          platform_source: latestPrompt.platform_source,
          prompt_number: latestPrompt.prompt_number,
          prompt_text: latestPrompt.prompt_text,
          created_at_epoch: latestPrompt.created_at_epoch
        });

        const chromaStart = Date.now();
        const promptText = latestPrompt.prompt_text;
        this.dbManager.getChromaSync()?.syncUserPrompt(
          latestPrompt.id,
          latestPrompt.memory_session_id,
          latestPrompt.project,
          promptText,
          latestPrompt.prompt_number,
          latestPrompt.created_at_epoch,
          latestPrompt.platform_source
        ).then(() => {
          const chromaDuration = Date.now() - chromaStart;
          const truncatedPrompt = promptText.length > 60
            ? promptText.substring(0, 60) + '...'
            : promptText;
          logger.debug('CHROMA', 'User prompt synced', {
            promptId: latestPrompt.id,
            duration: `${chromaDuration}ms`,
            prompt: truncatedPrompt
          });
        }).catch((error) => {
          logger.error('CHROMA', 'User prompt sync failed, continuing without vector search', {
            promptId: latestPrompt.id,
            prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
          }, error);
        });
      }

      await this.ensureGeneratorRunning(sessionDbId, 'init');

      this.eventBroadcaster.broadcastSessionStarted(sessionDbId, session.project);
    } else {
      logger.debug('HTTP', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false,
      contextInjected,
      status: 'initialized'
    });
  });

  private static readonly SIMPLE_TOOLS = new Set([
    'Read', 'Glob', 'Grep', 'LS', 'ListMcpResourcesTool'
  ]);

  private async applyTierRouting(session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>): Promise<void> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_TIER_ROUTING_ENABLED === 'false') {
      session.modelOverride = undefined;
      return;
    }

    session.modelOverride = undefined;

    const pending = this.sessionManager.getMessageBuffer().peekTypes(session.sessionDbId);

    if (pending.length === 0) {
      session.modelOverride = undefined;
      return;
    }

    const hasSummarize = pending.some(m => m.message_type === 'summarize');
    const allSimple = pending.every(m =>
      m.message_type === 'observation' && m.tool_name && SessionRoutes.SIMPLE_TOOLS.has(m.tool_name)
    );

    if (hasSummarize) {
      const summaryModel = settings.CLAUDE_MEM_TIER_SUMMARY_MODEL;
      if (summaryModel) {
        session.modelOverride = summaryModel;
        logger.debug('SESSION', `Tier routing: summary model`, {
          sessionId: session.sessionDbId, model: summaryModel
        });
      }
    } else if (allSimple) {
      const simpleModel = settings.CLAUDE_MEM_TIER_SIMPLE_MODEL;
      if (simpleModel) {
        session.modelOverride = simpleModel;
        logger.debug('SESSION', `Tier routing: simple model`, {
          sessionId: session.sessionDbId, model: simpleModel
        });
      }
    } else {
      session.modelOverride = undefined;
    }
  }
}

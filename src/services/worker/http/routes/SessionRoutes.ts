
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ingestObservation } from '../shared.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTags, isInternalProtocolPayload } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { ClaudeProvider } from '../../ClaudeProvider.js';
import { GeminiProvider } from '../../GeminiProvider.js';
import { OpenRouterProvider } from '../../OpenRouterProvider.js';
import { CodexProvider } from '../../CodexProvider.js';
import { getSelectedProvider, recordCmemFallbackIfEligible, releaseCmemGatewayProbe, selectProviderForGenerator } from '../../provider-dispatch.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { handleGeneratorExit } from '../../session/GeneratorExitHandler.js';
import { telemetryBuffer } from '../../../telemetry/buffer.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { USER_PROMPT_DEDUPE_WINDOW_MS } from '../../../../shared/user-prompts.js';
import {
  CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS,
  clearDependencyStatus,
  getDependencyStatus,
  isDependencyStatusInCooldown,
  recordClaudeCliSetupRequired,
} from '../../../../shared/dependency-health.js';
import { findClaudeExecutable } from '../../../../shared/find-claude-executable.js';
import { recordObserverFailure } from '../../../../shared/observer-health.js';
import {
  tryAdmitQuotaProbe,
  releaseQuotaProbe,
  recordQuotaExhausted,
  getQuotaCooldown,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  CODEX_SETUP_RECHECK_COOLDOWN_MS,
} from '../../../../shared/quota-cooldown.js';
import { isClassified, describeProviderError } from '../../provider-errors.js';
import { classifyClaudeError } from '../../ClaudeProvider.js';

const MAX_USER_PROMPT_BYTES = 256 * 1024;

/**
 * Collapse session.abortReason onto a closed telemetry enum. The raw value can
 * carry free text after a colon (e.g. 'quota:<provider message>') — never emit
 * it verbatim. Unknown or absent reasons map to 'none'.
 */
function normalizeAbortReason(
  reason: string | null | undefined
): 'idle' | 'shutdown' | 'overflow' | 'restart_guard' | 'quota' | 'none' {
  switch ((reason ?? '').split(':')[0]) {
    case 'idle': return 'idle';
    case 'shutdown': return 'shutdown';
    case 'overflow': return 'overflow';
    case 'restart-guard': return 'restart_guard';
    case 'quota': return 'quota';
    default: return 'none';
  }
}

export class SessionRoutes extends BaseRouteHandler {
  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: ClaudeProvider,
    private geminiAgent: GeminiProvider,
    private openRouterAgent: OpenRouterProvider,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService,
    private completionHandler: SessionCompletionHandler,
    private codexAgent?: CodexProvider,
  ) {
    super();
  }

  public async ensureGeneratorRunning(sessionDbId: number, source: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

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
            logger.info('SESSION', 'Claude setup dependency repaired; resuming generator start', {
              sessionId: sessionDbId,
              source,
            });
          } catch (error) {
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
        releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
        const cooldown = getQuotaCooldown(selectedProvider);
        logger.warn('SESSION', 'Skipping generator start while the provider quota cooldown is active', {
          sessionId: sessionDbId,
          source,
          provider: selectedProvider,
          ...(cooldown?.window ? { window: cooldown.window } : {}),
          probeInFlight: cooldown?.probeInFlightSinceMs !== null,
          retryInMs: cooldown
            ? Math.max(0, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - (Date.now() - cooldown.armedAtMs))
            : 0,
        });
        return;
      }

      const setupAdmission = selectedProvider === 'codex'
        ? tryAdmitQuotaProbe('codex-setup', Date.now(), CODEX_SETUP_RECHECK_COOLDOWN_MS)
        : { admitted: true, claimId: null };
      if (!setupAdmission.admitted) {
        releaseQuotaProbe(selectedProvider, admission.claimId);
        releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
        logger.warn('SESSION', 'Skipping Codex generator start while the CLI/login setup cooldown is active', {
          sessionId: sessionDbId, source,
        });
        return;
      }
      try {
        await this.applyTierRouting(session);
        // The claim travels with the run that took it: only that run may release
        // it, or an earlier generator's exit would clear a later session's probe.
        await this.startGeneratorWithProvider(
          session, selectedProvider, source, admission.claimId, selection.gatewayProbeClaimId, setupAdmission.claimId,
        );
      } catch (error) {
        releaseQuotaProbe('codex-setup', setupAdmission.claimId);
        releaseQuotaProbe(selectedProvider, admission.claimId);
        releaseCmemGatewayProbe(selection.gatewayProbeClaimId);
        throw error;
      }
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
      // Let current generator finish naturally, next one will use new provider
      // The shared conversationHistory ensures context is preserved
    }
  }

  private async startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    provider: 'claude' | 'gemini' | 'openrouter' | 'codex',
    source: string,
    /** The quota probe this run claimed, or null when it was admitted without one. */
    quotaProbeClaimId: number | null,
    /** The cmem-gateway re-probe this run claimed, or null when it took none. */
    gatewayProbeClaimId: number | null = null,
    setupProbeClaimId: number | null = null,
  ): Promise<void> {
    if (!session) return;

    if (session.abortController.signal.aborted) {
      logger.debug('SESSION', 'Resetting aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    const agent = provider === 'codex' ? this.codexAgent : provider === 'openrouter' ? this.openRouterAgent : (provider === 'gemini' ? this.geminiAgent : this.sdkAgent);
    const agentName = provider === 'codex' ? 'Codex' : provider === 'openrouter' ? 'OpenRouter' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');
    if (!agent) throw new Error('Codex provider is not configured');

    const actualQueueDepth = this.sessionManager.getMessageBuffer().getPendingCount(session.sessionDbId);

    logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
      sessionId: session.sessionDbId,
      queueDepth: actualQueueDepth,
      historyLength: session.conversationHistory.length
    });

    session.currentProvider = provider;
    session.quotaProbeClaimId = quotaProbeClaimId;
    session.lastGeneratorActivity = Date.now();
    // Providers refine this per-prompt ('init'|'ingest'|'summarize'); this is
    // the fallback when a generator dies before dispatching its first prompt.
    session.lastGeneratorSource = source;

    const myController = session.abortController;

    let skipGeneratorExitFinalization = false;
    let generatorPromise: Promise<void>;

    generatorPromise = agent.startSession(session, this.workerService)
      .catch(async error => {
        if (myController.signal.aborted) {
          logger.debug('HTTP', 'Generator catch: ignoring error after abort', { sessionId: session.sessionDbId });
          return;
        }

        const errorMsg = error instanceof Error ? error.message : String(error);
        // Native subscription failures must not discard the batch or fall back.
        if (provider === 'codex') {
          if (isClassified(error) && (error.kind === 'unrecoverable' || error.kind === 'auth_invalid')) {
            recordQuotaExhausted('codex-setup', error.message);
          }
          await this.sessionManager.resetProcessingToPending(session.sessionDbId);
          skipGeneratorExitFinalization = true;
          session.conversationHistory = [];
          session.forceInit = true;
        }
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
          if (session.generatorPromise === generatorPromise) {
            session.generatorPromise = null;
          }
          if (session.currentProvider === provider) {
            session.currentProvider = null;
          }
          // This run is over even though it skips finalization, so it must not
          // keep holding the probe.
          releaseQuotaProbe(provider, quotaProbeClaimId);
          releaseQuotaProbe('codex-setup', setupProbeClaimId);
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
        releaseQuotaProbe('codex-setup', setupProbeClaimId);
        releaseCmemGatewayProbe(gatewayProbeClaimId);

        await handleGeneratorExit(session, reason, {
          sessionManager: this.sessionManager,
          completionHandler: this.completionHandler,
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
            void this.ensureGeneratorRunning(session.sessionDbId, 'overflow-recycle')
              .catch(error => {
                logger.error('SESSION', 'Failed to resume the observer after recycling its conversation', {
                  sessionId: session.sessionDbId,
                }, error instanceof Error ? error : new Error(String(error)));
              });
          }, 0);
          resume.unref?.();
        }
      });
    session.generatorPromise = generatorPromise;
  }

  setupRoutes(app: express.Application): void {
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
  }

  private static readonly sessionInitByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    project: z.string().optional(),
    prompt: z.string().optional(),
    platformSource: z.string().optional(),
    customTitle: z.string().optional(),
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
  }).passthrough();

  private static readonly summarizeByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    last_assistant_message: z.string().optional(),
    agentId: z.string().optional(),
    platformSource: z.string().optional(),
    observedModel: z.string().min(1).max(200).optional(),
    observedBilling: z.string().min(1).max(40).optional(),
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


import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ingestObservation } from '../shared.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromPrompt, isInternalProtocolPayload } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { ClaudeProvider } from '../../ClaudeProvider.js';
import { GeminiProvider, isGeminiSelected, isGeminiAvailable } from '../../GeminiProvider.js';
import { OpenRouterProvider, isOpenRouterSelected, isOpenRouterAvailable } from '../../OpenRouterProvider.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { handleGeneratorExit } from '../../session/GeneratorExitHandler.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { getUptimeSeconds } from '../../../../shared/uptime.js';

const MAX_USER_PROMPT_BYTES = 256 * 1024;

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
  ) {
    super();
  }

  private getActiveAgent(): ClaudeProvider | GeminiProvider | OpenRouterProvider {
    if (isOpenRouterSelected()) {
      if (isOpenRouterAvailable()) {
        logger.debug('SESSION', 'Using OpenRouter agent');
        return this.openRouterAgent;
      } else {
        throw new Error('OpenRouter provider selected but no API key configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }
    }
    if (isGeminiSelected()) {
      if (isGeminiAvailable()) {
        logger.debug('SESSION', 'Using Gemini agent');
        return this.geminiAgent;
      } else {
        throw new Error('Gemini provider selected but no API key configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }
    }
    return this.sdkAgent;
  }

  private getSelectedProvider(): 'claude' | 'gemini' | 'openrouter' {
    if (isOpenRouterSelected() && isOpenRouterAvailable()) {
      return 'openrouter';
    }
    return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
  }

  public ensureGeneratorRunning(sessionDbId: number, source: string): void {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    const selectedProvider = this.getSelectedProvider();

    if (!session.generatorPromise) {
      this.applyTierRouting(session);
      this.startGeneratorWithProvider(session, selectedProvider, source);
      return;
    }

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

  private startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    provider: 'claude' | 'gemini' | 'openrouter',
    source: string
  ): void {
    if (!session) return;

    if (session.abortController.signal.aborted) {
      logger.debug('SESSION', 'Resetting aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    const agent = provider === 'openrouter' ? this.openRouterAgent : (provider === 'gemini' ? this.geminiAgent : this.sdkAgent);
    const agentName = provider === 'openrouter' ? 'OpenRouter' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const actualQueueDepth = pendingStore.getPendingCount(session.sessionDbId);

    logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
      sessionId: session.sessionDbId,
      queueDepth: actualQueueDepth,
      historyLength: session.conversationHistory.length
    });

    session.currentProvider = provider;
    session.lastGeneratorActivity = Date.now();

    const myController = session.abortController;

    session.generatorPromise = agent.startSession(session, this.workerService)
      .catch(error => {
        if (myController.signal.aborted) {
          logger.debug('HTTP', 'Generator catch: ignoring error after abort', { sessionId: session.sessionDbId });
          return;
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')) {
          logger.warn('SESSION', 'Generator killed by external signal — aborting session to prevent respawn', {
            sessionId: session.sessionDbId,
            provider,
            error: errorMsg
          });
          myController.abort();
          return;
        }

        logger.error('SESSION', `Generator failed`, {
          sessionId: session.sessionDbId,
          provider: provider,
          error: errorMsg
        }, error);

        const pendingStore = this.sessionManager.getPendingMessageStore();
        try {
          const cleared = pendingStore.clearPendingForSession(session.sessionDbId);
          if (cleared > 0) {
            logger.error('SESSION', `Cleared pending messages after generator error`, {
              sessionId: session.sessionDbId,
              cleared
            });
          }
        } catch (dbError) {
          const normalizedDbError = dbError instanceof Error ? dbError : new Error(String(dbError));
          logger.error('HTTP', 'Failed to clear pending messages', {
            sessionId: session.sessionDbId
          }, normalizedDbError);
        }
      })
      .finally(async () => {
        const reason = session.abortReason ?? null;
        session.abortReason = null;  // consume the reason
        await handleGeneratorExit(session, reason, {
          sessionManager: this.sessionManager,
          completionHandler: this.completionHandler,
          restartGenerator: (s, source) => {
            this.applyTierRouting(s);
            this.startGeneratorWithProvider(s, this.getSelectedProvider(), source);
          },
        });
      });
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
    app.get('/api/sessions/status', this.handleStatusByClaudeId.bind(this));
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
  }).passthrough();

  private handleObservationsByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const {
      contentSessionId,
      tool_name,
      tool_input,
      tool_response,
      cwd,
      platformSource,
      agentId,
      agentType,
      tool_use_id,
      toolUseId,
    } = req.body;

    const result = ingestObservation({
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

  private handleSummarizeByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, last_assistant_message, agentId } = req.body;
    const platformSource = normalizePlatformSource(req.body.platformSource);

    if (agentId) {
      res.json({ status: 'skipped', reason: 'subagent_context' });
      return;
    }

    const store = this.dbManager.getSessionStore();

    const sessionDbId = store.createSDKSession(contentSessionId, '', '', undefined, platformSource);
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);

    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'summarize',
      sessionDbId
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    const cleanedLastAssistantMessage = last_assistant_message
      ? stripMemoryTagsFromPrompt(String(last_assistant_message))
      : last_assistant_message;
    this.sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage);

    this.ensureGeneratorRunning(sessionDbId, 'summarize');

    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  private handleStatusByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const contentSessionId = req.query.contentSessionId as string;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId query parameter');
    }

    const store = this.dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    const session = this.sessionManager.getSession(sessionDbId);

    if (!session) {
      res.json({ status: 'not_found', queueLength: 0 });
      return;
    }

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const queueLength = pendingStore.getPendingCount(sessionDbId);

    res.json({
      status: 'active',
      sessionDbId,
      queueLength,
      summaryStored: session.lastSummaryStored ?? null,
      uptime: getUptimeSeconds(session.startTime)
    });
  });

  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId } = req.body;

    const project = req.body.project || 'unknown';
    const rawPrompt = typeof req.body.prompt === 'string' ? req.body.prompt : undefined;
    const platformSource = normalizePlatformSource(req.body.platformSource);
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

    const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId);
    const promptNumber = currentCount + 1;

    const memorySessionId = dbSession?.memory_session_id || null;
    if (promptNumber > 1) {
      logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
    } else {
      logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
    }

    const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

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

    store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt);

    const contextInjected = this.sessionManager.getSession(sessionDbId) !== undefined;

    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber,
      contextInjected
    });

    if (platformSource !== 'cursor') {
      const sdkPrompt = cleanedPrompt.startsWith('/') ? cleanedPrompt.substring(1) : cleanedPrompt;
      const session = this.sessionManager.initializeSession(sessionDbId, sdkPrompt, promptNumber);

      const latestPrompt = store.getLatestUserPrompt(session.contentSessionId);

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
          latestPrompt.created_at_epoch
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

      this.ensureGeneratorRunning(sessionDbId, 'init');

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

  private applyTierRouting(session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>): void {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_TIER_ROUTING_ENABLED === 'false') {
      session.modelOverride = undefined;
      return;
    }

    session.modelOverride = undefined;

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const pending = pendingStore.peekPendingTypes(session.sessionDbId);

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


import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { buildIsolatedEnv, getAuthMethodDescription } from '../../shared/EnvManager.js';
import type { ActiveSession, SDKUserMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { processAgentResponse, type WorkerRef } from './agents/index.js';
import {
  createSdkSpawnFactory,
  getSdkProcessForSession,
  ensureSdkProcessExit,
  waitForSlot,
} from '../../supervisor/process-registry.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  private resetSessionForFreshStart(session: ActiveSession): void {
    this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);
    session.memorySessionId = null;
    session.forceInit = true;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const cwdTracker = { lastCwd: undefined as string | undefined };

    const claudePath = this.findClaudeExecutable();

    const modelId = session.modelOverride || this.getModelId();
    const disallowedTools = [
      'Bash',           // Prevent infinite loops
      'Read',           // No file reading
      'Write',          // No file writing
      'Edit',           // No file editing
      'Grep',           // No code searching
      'Glob',           // No file pattern matching
      'WebFetch',       // No web fetching
      'WebSearch',      // No web searching
      'Task',           // No spawning sub-agents
      'NotebookEdit',   // No notebook editing
      'AskUserQuestion',// No asking questions
      'TodoWrite'       
    ];

    const messageGenerator = this.createMessageGenerator(session, cwdTracker);

    const hasRealMemorySessionId = !!session.memorySessionId;
    const shouldResume = hasRealMemorySessionId && session.lastPromptNumber > 1 && !session.forceInit;

    if (session.forceInit) {
      logger.info('SDK', 'forceInit flag set, starting fresh SDK session', {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId
      });
      session.forceInit = false;
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent = parseInt(settings.CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10) || 2;
    await waitForSlot(maxConcurrent, 60_000);

    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());
    const authMethod = getAuthMethodDescription();

    logger.info('SDK', 'Starting SDK query', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId ?? undefined,
      hasRealMemorySessionId,
      shouldResume,
      resume_parameter: shouldResume ? session.memorySessionId : '(none - fresh start)',
      lastPromptNumber: session.lastPromptNumber,
      authMethod
    });

    if (session.lastPromptNumber > 1) {
      logger.debug('SDK', `[ALIGNMENT] Resume Decision | contentSessionId=${session.contentSessionId} | memorySessionId=${session.memorySessionId} | prompt#=${session.lastPromptNumber} | hasRealMemorySessionId=${hasRealMemorySessionId} | shouldResume=${shouldResume} | resumeWith=${shouldResume ? session.memorySessionId : 'NONE'}`);
    } else {
      const hasStaleMemoryId = hasRealMemorySessionId;
      logger.debug('SDK', `[ALIGNMENT] First Prompt (INIT) | contentSessionId=${session.contentSessionId} | prompt#=${session.lastPromptNumber} | hasStaleMemoryId=${hasStaleMemoryId} | action=START_FRESH | Will capture new memorySessionId from SDK response`);
      if (hasStaleMemoryId) {
        logger.warn('SDK', `Skipping resume for INIT prompt despite existing memorySessionId=${session.memorySessionId} - SDK context was lost (worker restart or crash recovery)`);
      }
    }

    ensureDir(OBSERVER_SESSIONS_DIR);
    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model: modelId,
        cwd: OBSERVER_SESSIONS_DIR,
        ...(shouldResume && session.memorySessionId ? { resume: session.memorySessionId } : {}),
        disallowedTools,
        abortController: session.abortController,
        pathToClaudeCodeExecutable: claudePath,
        spawnClaudeCodeProcess: createSdkSpawnFactory(session.sessionDbId),
        env: isolatedEnv,  // Use isolated credentials from ~/.claude-mem/.env, not process.env
        mcpServers: {},
        settingSources: [],
        strictMcpConfig: true,
      }
    });

    try {
      for await (const message of queryResult) {
        if (message.session_id && message.session_id !== session.memorySessionId) {
          const previousId = session.memorySessionId;
          session.memorySessionId = message.session_id;
          this.dbManager.getSessionStore().ensureMemorySessionIdRegistered(
            session.sessionDbId,
            message.session_id
          );
          const verification = this.dbManager.getSessionStore().getSessionById(session.sessionDbId);
          const dbVerified = verification?.memory_session_id === message.session_id;
          const logMessage = previousId
            ? `MEMORY_ID_CHANGED | sessionDbId=${session.sessionDbId} | from=${previousId} | to=${message.session_id} | dbVerified=${dbVerified}`
            : `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | memorySessionId=${message.session_id} | dbVerified=${dbVerified}`;
          logger.info('SESSION', logMessage, {
            sessionId: session.sessionDbId,
            memorySessionId: message.session_id,
            previousId
          });
          if (!dbVerified) {
            logger.error('SESSION', `MEMORY_ID_MISMATCH | sessionDbId=${session.sessionDbId} | expected=${message.session_id} | got=${verification?.memory_session_id}`, {
              sessionId: session.sessionDbId
            });
          }
          logger.debug('SDK', `[ALIGNMENT] ${previousId ? 'Updated' : 'Captured'} | contentSessionId=${session.contentSessionId} → memorySessionId=${message.session_id} | Future prompts will resume with this ID`);
        }

        if (message.type === 'assistant') {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : typeof content === 'string' ? content : '';

          if (textContent.includes('prompt is too long') ||
              textContent.includes('context window')) {
            logger.error('SDK', 'Context overflow detected - terminating session and forcing fresh start');
            this.resetSessionForFreshStart(session);
            session.abortReason = 'overflow';
            session.abortController.abort();
            return;
          }

          const responseSize = textContent.length;

          const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;

          const usage = message.message.usage;
          if (usage) {
            session.cumulativeInputTokens += usage.input_tokens || 0;
            session.cumulativeOutputTokens += usage.output_tokens || 0;

            if (usage.cache_creation_input_tokens) {
              session.cumulativeInputTokens += usage.cache_creation_input_tokens;
            }

            logger.debug('SDK', 'Token usage captured', {
              sessionId: session.sessionDbId,
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheCreation: usage.cache_creation_input_tokens || 0,
              cacheRead: usage.cache_read_input_tokens || 0,
              cumulativeInput: session.cumulativeInputTokens,
              cumulativeOutput: session.cumulativeOutputTokens
            });
          }

          const discoveryTokens = (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse;

          const originalTimestamp = session.earliestPendingTimestamp;

          if (responseSize > 0) {
            const truncatedResponse = responseSize > 100
              ? textContent.substring(0, 100) + '...'
              : textContent;
            logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
              sessionId: session.sessionDbId,
              promptNumber: session.lastPromptNumber
            }, truncatedResponse);
          }

          if (typeof textContent === 'string' && textContent.includes('Prompt is too long')) {
            this.resetSessionForFreshStart(session);
            logger.error('SDK', 'Context overflow — cleared memorySessionId so next spawn starts fresh', {
              sessionDbId: session.sessionDbId
            });
            throw new Error('Claude session context overflow: prompt is too long');
          }

          if (typeof textContent === 'string' && textContent.includes('Invalid API key')) {
            throw new Error('Invalid API key: check your API key configuration in ~/.claude-mem/settings.json or ~/.claude-mem/.env');
          }

          await processAgentResponse(
            textContent,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            discoveryTokens,
            originalTimestamp,
            'SDK',
            cwdTracker.lastCwd,
            modelId
          );
        }

        if (message.type === 'result' && message.subtype === 'success') {
          // Usage telemetry is captured at SDK level
        }
      }
    } finally {
      const tracked = getSdkProcessForSession(session.sessionDbId);
      if (tracked && tracked.process.exitCode === null) {
        await ensureSdkProcessExit(tracked, 5000);
      }
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`
    });
  }

  private async *createMessageGenerator(
    session: ActiveSession,
    cwdTracker: { lastCwd: string | undefined }
  ): AsyncIterableIterator<SDKUserMessage> {
    const mode = ModeManager.getInstance().getActiveMode();

    const isInitPrompt = session.lastPromptNumber === 1;
    logger.info('SDK', 'Creating message generator', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      lastPromptNumber: session.lastPromptNumber,
      isInitPrompt,
      promptType: isInitPrompt ? 'INIT' : 'CONTINUATION'
    });

    const initPrompt = isInitPrompt
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    yield {
      type: 'user',
      message: {
        role: 'user',
        content: initPrompt
      },
      session_id: session.contentSessionId,
      parent_tool_use_id: null,
      isSynthetic: true
    };

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        cwdTracker.lastCwd = message.cwd;
      }

      if (message.type === 'observation') {
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        const obsPrompt = buildObservationPrompt({
          id: 0, // Not used in prompt
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: Date.now(),
          cwd: message.cwd
        });

        session.conversationHistory.push({ role: 'user', content: obsPrompt });

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: obsPrompt
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      } else if (message.type === 'summarize') {
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_assistant_message: message.last_assistant_message || ''
        }, mode);

        session.conversationHistory.push({ role: 'user', content: summaryPrompt });

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: summaryPrompt
          },
          session_id: session.contentSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      }
    }
  }

  private findClaudeExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    if (settings.CLAUDE_CODE_PATH) {
      const { existsSync } = require('fs');
      if (!existsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_CODE_PATH;
    }

    if (process.platform === 'win32') {
      try {
        execSync('where claude.cmd', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        return 'claude.cmd'; 
      } catch {
        // Fall through to generic error
      }
    }

    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude',
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim().split('\n')[0].trim();

      if (claudePath) return claudePath;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SDK', 'Claude executable auto-detection failed', {}, error);
      } else {
        logger.debug('SDK', 'Claude executable auto-detection failed with non-Error', {}, new Error(String(error)));
      }
    }

    throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
  }

  private getModelId(): string {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }
}

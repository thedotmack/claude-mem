/**
 * SDKAgent: SDK query loop handler
 *
 * Responsibility:
 * - Spawn Claude subprocess via Agent SDK
 * - Run event-driven query loop (no polling)
 * - Process SDK responses (observations, summaries)
 * - Sync to database and Chroma
 */

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
import { createPidCapturingSpawn, getProcessBySession, ensureProcessExit } from './ProcessRegistry.js';

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

export class SDKAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start SDK agent for a session (event-driven, no polling)
   * @param worker WorkerService reference for spinner control (optional)
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // Track cwd from messages for CLAUDE.md generation (worktree support)
    // Uses mutable object so generator updates are visible in response processing
    const cwdTracker = { lastCwd: undefined as string | undefined };

    // Find Claude executable
    const claudePath = this.findClaudeExecutable();

    // Get model ID and disallowed tools
    const modelId = this.getModelId();
    // Memory agent is OBSERVER ONLY - no tools allowed
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
      'TodoWrite'       // No todo management
    ];

    // Create message generator (event-driven)
    const messageGenerator = this.createMessageGenerator(session, cwdTracker);

    // CRITICAL: Only resume if:
    // 1. memorySessionId exists (was captured from a previous SDK response)
    // 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
    // 3. forceInit is NOT set (stale session recovery clears this)
    // On worker restart or crash recovery, memorySessionId may exist from a previous
    // SDK session but we must NOT resume because the SDK context was lost.
    // NEVER use contentSessionId for resume - that would inject messages into the user's transcript!
    const hasRealMemorySessionId = !!session.memorySessionId;
    const shouldResume = hasRealMemorySessionId && session.lastPromptNumber > 1 && !session.forceInit;

    // Clear forceInit after using it
    if (session.forceInit) {
      logger.info('SDK', 'forceInit flag set, starting fresh SDK session', {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId
      });
      session.forceInit = false;
    }

    // Build isolated environment from ~/.claude-mem/.env
    // This prevents Issue #733: random ANTHROPIC_API_KEY from project .env files
    // being used instead of the configured auth method (CLI subscription or explicit API key)
    const isolatedEnv = buildIsolatedEnv();
    const authMethod = getAuthMethodDescription();

    logger.info('SDK', 'Starting SDK query', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId,
      hasRealMemorySessionId,
      shouldResume,
      resume_parameter: shouldResume ? session.memorySessionId : '(none - fresh start)',
      lastPromptNumber: session.lastPromptNumber,
      authMethod
    });

    // Debug-level alignment logs for detailed tracing
    if (session.lastPromptNumber > 1) {
      logger.debug('SDK', `[ALIGNMENT] Resume Decision | contentSessionId=${session.contentSessionId} | memorySessionId=${session.memorySessionId} | prompt#=${session.lastPromptNumber} | hasRealMemorySessionId=${hasRealMemorySessionId} | shouldResume=${shouldResume} | resumeWith=${shouldResume ? session.memorySessionId : 'NONE'}`);
    } else {
      // INIT prompt - never resume even if memorySessionId exists (stale from previous session)
      const hasStaleMemoryId = hasRealMemorySessionId;
      logger.debug('SDK', `[ALIGNMENT] First Prompt (INIT) | contentSessionId=${session.contentSessionId} | prompt#=${session.lastPromptNumber} | hasStaleMemoryId=${hasStaleMemoryId} | action=START_FRESH | Will capture new memorySessionId from SDK response`);
      if (hasStaleMemoryId) {
        logger.warn('SDK', `Skipping resume for INIT prompt despite existing memorySessionId=${session.memorySessionId} - SDK context was lost (worker restart or crash recovery)`);
      }
    }

    // Run Agent SDK query loop
    // Only resume if we have a captured memory session ID
    // Use custom spawn to capture PIDs for zombie process cleanup (Issue #737)
    // Use dedicated cwd to isolate observer sessions from user's `claude --resume` list
    ensureDir(OBSERVER_SESSIONS_DIR);
    // CRITICAL: Pass isolated env to prevent Issue #733 (API key pollution from project .env files)
    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model: modelId,
        // Isolate observer sessions - they'll appear under project "observer-sessions"
        // instead of polluting user's actual project resume lists
        cwd: OBSERVER_SESSIONS_DIR,
        // Only resume if shouldResume is true (memorySessionId exists, not first prompt, not forceInit)
        ...(shouldResume && { resume: session.memorySessionId }),
        disallowedTools,
        abortController: session.abortController,
        pathToClaudeCodeExecutable: claudePath,
        // Custom spawn function captures PIDs to fix zombie process accumulation
        spawnClaudeCodeProcess: createPidCapturingSpawn(session.sessionDbId),
        env: isolatedEnv  // Use isolated credentials from ~/.claude-mem/.env, not process.env
      }
    });

    // Process SDK messages
    for await (const message of queryResult) {
      // Capture or update memory session ID from SDK message
      // IMPORTANT: The SDK may return a DIFFERENT session_id on resume than what we sent!
      // We must always sync the DB to match what the SDK actually uses.
      //
      // MULTI-TERMINAL COLLISION FIX (FK constraint bug):
      // Use ensureMemorySessionIdRegistered() instead of updateMemorySessionId() because:
      // 1. It's idempotent - safe to call multiple times
      // 2. It verifies the update happened (SELECT before UPDATE)
      // 3. Consistent with ResponseProcessor's usage pattern
      // This ensures FK constraint compliance BEFORE any observations are stored.
      if (message.session_id && message.session_id !== session.memorySessionId) {
        const previousId = session.memorySessionId;
        session.memorySessionId = message.session_id;
        // Persist to database IMMEDIATELY for FK constraint compliance
        // This must happen BEFORE any observations referencing this ID are stored
        this.dbManager.getSessionStore().ensureMemorySessionIdRegistered(
          session.sessionDbId,
          message.session_id
        );
        // Verify the update by reading back from DB
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
        // Debug-level alignment log for detailed tracing
        logger.debug('SDK', `[ALIGNMENT] ${previousId ? 'Updated' : 'Captured'} | contentSessionId=${session.contentSessionId} → memorySessionId=${message.session_id} | Future prompts will resume with this ID`);
      }

      // Handle assistant messages
      if (message.type === 'assistant') {
        const content = message.message.content;
        const textContent = Array.isArray(content)
          ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
          : typeof content === 'string' ? content : '';

        // Check for context overflow - prevents infinite retry loops
        if (textContent.includes('prompt is too long') ||
            textContent.includes('context window')) {
          logger.error('SDK', 'Context overflow detected - terminating session');
          session.abortController.abort();
          return;
        }

        const responseSize = textContent.length;

        // Capture token state BEFORE updating (for delta calculation)
        const tokensBeforeResponse = session.cumulativeInputTokens + session.cumulativeOutputTokens;

        // Extract and track token usage
        const usage = message.message.usage;
        if (usage) {
          session.cumulativeInputTokens += usage.input_tokens || 0;
          session.cumulativeOutputTokens += usage.output_tokens || 0;

          // Cache creation counts as discovery, cache read doesn't
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

        // Calculate discovery tokens (delta for this response only)
        const discoveryTokens = (session.cumulativeInputTokens + session.cumulativeOutputTokens) - tokensBeforeResponse;

        // Process response (empty or not) and mark messages as processed
        // Capture earliest timestamp BEFORE processing (will be cleared after)
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

        // Detect fatal context overflow and terminate gracefully (issue #870)
        if (typeof textContent === 'string' && textContent.includes('Prompt is too long')) {
          throw new Error('Claude session context overflow: prompt is too long');
        }

        // Parse and process response using shared ResponseProcessor
        await processAgentResponse(
          textContent,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          discoveryTokens,
          originalTimestamp,
          'SDK',
          cwdTracker.lastCwd
        );
      }

      // Log result messages
      if (message.type === 'result' && message.subtype === 'success') {
        // Usage telemetry is captured at SDK level
      }
    }

    // Mark session complete
    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`
    });
  }

  /**
   * Create event-driven message generator (yields messages from SessionManager)
   *
   * CRITICAL: CONTINUATION PROMPT LOGIC
   * ====================================
   * This is where NEW hook's dual-purpose nature comes together:
   *
   * - Prompt #1 (lastPromptNumber === 1): buildInitPrompt
   *   - Full initialization prompt with instructions
   *   - Sets up the SDK agent's context
   *
   * - Prompt #2+ (lastPromptNumber > 1): buildContinuationPrompt
   *   - Continuation prompt for same session
   *   - Includes session context and prompt number
   *
   * BOTH prompts receive session.contentSessionId:
   * - This comes from the hook's session_id (see new-hook.ts)
   * - Same session_id used by SAVE hook to store observations
   * - This is how everything stays connected in one unified session
   *
   * NO SESSION EXISTENCE CHECKS NEEDED:
   * - SessionManager.initializeSession already fetched this from database
   * - Database row was created by new-hook's createSDKSession call
   * - We just use the session_id we're given - simple and reliable
   *
   * SHARED CONVERSATION HISTORY:
   * - Each user message is added to session.conversationHistory
   * - This allows provider switching (Claude→Gemini) with full context
   * - SDK manages its own internal state, but we mirror it for interop
   *
   * CWD TRACKING:
   * - cwdTracker is a mutable object shared with startSession
   * - As messages with cwd are processed, cwdTracker.lastCwd is updated
   * - This enables processAgentResponse to use the correct cwd for CLAUDE.md
   */
  private async *createMessageGenerator(
    session: ActiveSession,
    cwdTracker: { lastCwd: string | undefined }
  ): AsyncIterableIterator<SDKUserMessage> {
    // Load active mode
    const mode = ModeManager.getInstance().getActiveMode();

    // Build initial prompt
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

    // Add to shared conversation history for provider interop
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    // Yield initial user prompt with context (or continuation if prompt #2+)
    // CRITICAL: Both paths use session.contentSessionId from the hook
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

    // Consume pending messages from SessionManager (event-driven, no polling)
    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
      // The message is now in 'processing' status in DB until ResponseProcessor calls confirmProcessed()
      session.processingMessageIds.push(message._persistentId);

      // Capture cwd from each message for worktree support
      if (message.cwd) {
        cwdTracker.lastCwd = message.cwd;
      }

      if (message.type === 'observation') {
        // Update last prompt number
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

        // Add to shared conversation history for provider interop
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

        // Add to shared conversation history for provider interop
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

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Find Claude executable (inline, called once per session)
   */
  private findClaudeExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // 1. Check configured path
    if (settings.CLAUDE_CODE_PATH) {
      // Lazy load fs to keep startup fast
      const { existsSync } = require('fs');
      if (!existsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_CODE_PATH;
    }

    // 2. Try auto-detection
    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude',
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim().split('\n')[0].trim();

      if (claudePath) return claudePath;
    } catch (error) {
      // [ANTI-PATTERN IGNORED]: Fallback behavior - which/where failed, continue to throw clear error
      logger.debug('SDK', 'Claude executable auto-detection failed', {}, error as Error);
    }

    throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
  }

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }
}

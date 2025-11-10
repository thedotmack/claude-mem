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
import { existsSync, readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import type { ActiveSession, SDKUserMessage, PendingMessage } from '../worker-types.js';

// Import Agent SDK (assumes it's installed)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

interface JITFilterRequest {
  userPrompt: string;
  resolve: (ids: number[]) => void;
  reject: (error: Error) => void;
}

export class SDKAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  // JIT filter coordination
  private jitFilterQueues: Map<number, {
    requests: JITFilterRequest[];
    emitter: EventEmitter;
    currentResponse: string;
  }> = new Map();

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start SDK agent for a session (event-driven, no polling)
   * @param worker WorkerService reference for spinner control (optional)
   */
  async startSession(session: ActiveSession, worker?: any): Promise<void> {
    try {
      // Find Claude executable
      const claudePath = this.findClaudeExecutable();

      // Get model ID and disallowed tools
      const modelId = this.getModelId();
      const disallowedTools = ['Bash']; // Prevent infinite loops

      // Create message generator (event-driven)
      const messageGenerator = this.createMessageGenerator(session);

      // Run Agent SDK query loop
      const queryResult = query({
        prompt: messageGenerator,
        options: {
          model: modelId,
          disallowedTools,
          abortController: session.abortController,
          pathToClaudeCodeExecutable: claudePath
        }
      });

      // Process SDK messages
      for await (const message of queryResult) {
        // Handle assistant messages
        if (message.type === 'assistant') {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : typeof content === 'string' ? content : '';

          const responseSize = textContent.length;
          logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
            sessionId: session.sessionDbId,
            promptNumber: session.lastPromptNumber
          });

          // Parse and process response
          await this.processSDKResponse(session, textContent, worker);
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

      this.dbManager.getSessionStore().markSessionCompleted(session.sessionDbId);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'Agent aborted', { sessionId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error);
      }
      throw error;
    } finally {
      // Cleanup
      this.sessionManager.deleteSession(session.sessionDbId).catch(() => {});
    }
  }

  /**
   * Start JIT filter session (persistent, waits for filter requests)
   */
  async startJitSession(
    session: ActiveSession,
    observations: Array<{id: number, type: string, title: string}>
  ): Promise<void> {
    try {
      // Initialize JIT filter queue
      this.jitFilterQueues.set(session.sessionDbId, {
        requests: [],
        emitter: new EventEmitter(),
        currentResponse: ''
      });

      // Setup abort controller for JIT session
      session.jitAbortController = new AbortController();
      session.jitSessionId = `jit-${session.claudeSessionId}`;

      // Find Claude executable
      const claudePath = this.findClaudeExecutable();
      const modelId = this.getModelId();

      // Create JIT message generator
      const messageGenerator = this.createJitMessageGenerator(session.sessionDbId, observations);

      // Run Agent SDK query loop for JIT filtering
      const queryResult = query({
        prompt: messageGenerator,
        options: {
          model: modelId,
          disallowedTools: ['Bash'],
          abortController: session.jitAbortController,
          pathToClaudeCodeExecutable: claudePath
        }
      });

      // Store generator promise
      session.jitGeneratorPromise = (async () => {
        for await (const message of queryResult) {
          if (message.type === 'assistant') {
            const content = message.message.content;
            const textContent = Array.isArray(content)
              ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
              : typeof content === 'string' ? content : '';

            // Process filter response
            await this.processJitFilterResponse(session.sessionDbId, textContent);
          }
        }
      })().catch(error => {
        if (error.name !== 'AbortError') {
          logger.failure('SDK', 'JIT session error', { sessionDbId: session.sessionDbId }, error);
        }
      });

      logger.info('SDK', 'JIT session started', {
        sessionDbId: session.sessionDbId,
        observationCount: observations.length
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'JIT session aborted', { sessionDbId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'JIT session error', { sessionDbId: session.sessionDbId }, error);
      }
      throw error;
    }
  }

  /**
   * Create JIT message generator (yields filter requests on-demand)
   */
  private async *createJitMessageGenerator(
    sessionDbId: number,
    observations: Array<{id: number, type: string, title: string}>
  ): AsyncIterableIterator<SDKUserMessage> {
    // Get session for jitSessionId
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session || !session.jitSessionId) {
      throw new Error(`No JIT session ID for session ${sessionDbId}`);
    }

    // Yield initial prompt with observation list
    const observationList = observations.map(obs => {
      const typeEmoji = this.getTypeEmoji(obs.type);
      return `${typeEmoji} #${obs.id}: ${obs.title || 'Untitled'}`;
    }).join('\n');

    yield {
      type: 'user',
      message: {
        role: 'user',
        content: `You are a context filter for an AI memory system. You'll receive a list of past observations, then filter requests asking which observations are relevant to specific user questions.

# Available observations:
${observationList}

Reply "READY" when you've loaded the observation list.`
      },
      session_id: session.jitSessionId,
      parent_tool_use_id: null,
      isSynthetic: true
    };

    // Wait for filter requests
    const queue = this.jitFilterQueues.get(sessionDbId);
    if (!queue) {
      throw new Error(`No JIT queue for session ${sessionDbId}`);
    }

    const abortController = session.jitAbortController;
    if (!abortController) {
      throw new Error(`No JIT abort controller for session ${sessionDbId}`);
    }

    while (!abortController.signal.aborted) {
      // Wait for filter request if queue is empty
      if (queue.requests.length === 0) {
        await new Promise<void>(resolve => {
          const handler = () => resolve();
          queue.emitter.once('request', handler);

          // Also listen for abort
          abortController.signal.addEventListener('abort', () => {
            queue.emitter.off('request', handler);
            resolve();
          }, { once: true });
        });
      }

      // Process pending requests
      if (queue.requests.length > 0) {
        const request = queue.requests[0]; // Keep in queue until processed
        queue.currentResponse = ''; // Reset response buffer

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: `# User's current question:
${request.userPrompt}

# Task:
Select the 3-5 most relevant observation IDs (just the numbers) that would help answer this question.
If nothing is relevant, respond with "NONE".

Respond ONLY with comma-separated IDs (e.g., "1234,5678,9012") or "NONE".`
          },
          session_id: session.jitSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      }
    }
  }

  /**
   * Process JIT filter response and resolve the corresponding promise
   */
  private async processJitFilterResponse(sessionDbId: number, textContent: string): Promise<void> {
    const queue = this.jitFilterQueues.get(sessionDbId);
    if (!queue || queue.requests.length === 0) {
      return; // No pending request (might be initial "READY" response)
    }

    // Accumulate response
    queue.currentResponse += textContent;

    // Check if response is complete (simple heuristic: contains NONE or numbers)
    const response = queue.currentResponse.trim();
    if (response === 'READY') {
      queue.currentResponse = ''; // Clear initial response
      return;
    }

    if (response === 'NONE' || response === '' || /^\d+(,\d+)*$/.test(response)) {
      // Response is complete, resolve promise
      const request = queue.requests.shift()!;
      queue.currentResponse = '';

      if (response === 'NONE' || !response) {
        request.resolve([]);
      } else {
        const selectedIds = response
          .split(',')
          .map((id: string) => parseInt(id.trim(), 10))
          .filter((id: number) => !isNaN(id));
        request.resolve(selectedIds);
      }

      logger.debug('SDK', 'JIT filter response processed', {
        sessionDbId,
        selectedIds: response
      });
    }
  }

  /**
   * Create event-driven message generator (yields messages from SessionManager)
   */
  private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
    // Yield initial user prompt with context (or continuation if prompt #2+)
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: session.lastPromptNumber === 1
          ? buildInitPrompt(session.project, session.claudeSessionId, session.userPrompt)
          : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber)
      },
      session_id: session.claudeSessionId,
      parent_tool_use_id: null,
      isSynthetic: true
    };

    // Consume pending messages from SessionManager (event-driven, no polling)
    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      if (message.type === 'observation') {
        // Update last prompt number
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: buildObservationPrompt({
              id: 0, // Not used in prompt
              tool_name: message.tool_name!,
              tool_input: JSON.stringify(message.tool_input),
              tool_output: JSON.stringify(message.tool_response),
              created_at_epoch: Date.now()
            })
          },
          session_id: session.claudeSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      } else if (message.type === 'summarize') {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: buildSummaryPrompt({
              id: session.sessionDbId,
              sdk_session_id: session.sdkSessionId,
              project: session.project,
              user_prompt: session.userPrompt
            })
          },
          session_id: session.claudeSessionId,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      }
    }
  }

  /**
   * Process SDK response text (parse XML, save to database, sync to Chroma)
   */
  private async processSDKResponse(session: ActiveSession, text: string, worker?: any): Promise<void> {
    // Parse observations
    const observations = parseObservations(text, session.claudeSessionId);

    // Store observations
    for (const obs of observations) {
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber
      );

      // Sync to Chroma (fire-and-forget)
      this.dbManager.getChromaSync().syncObservation(
        obsId,
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        createdAtEpoch
      ).catch(() => {});

      // Broadcast to SSE clients (for web UI)
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_observation',
          observation: {
            id: obsId,
            sdk_session_id: session.sdkSessionId,
            session_id: session.claudeSessionId,
            type: obs.type,
            title: obs.title,
            subtitle: obs.subtitle,
            text: obs.text || null,
            narrative: obs.narrative || null,
            facts: JSON.stringify(obs.facts || []),
            concepts: JSON.stringify(obs.concepts || []),
            files_read: JSON.stringify(obs.files || []),
            files_modified: JSON.stringify([]),
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }

      logger.info('SDK', 'Observation saved', { obsId, type: obs.type });
    }

    // Parse summary
    const summary = parseSummary(text, session.sessionDbId);

    // Store summary
    if (summary) {
      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.claudeSessionId,
        session.project,
        summary,
        session.lastPromptNumber
      );

      // Sync to Chroma (fire-and-forget)
      this.dbManager.getChromaSync().syncSummary(
        summaryId,
        session.claudeSessionId,
        session.project,
        summary,
        session.lastPromptNumber,
        createdAtEpoch
      ).catch(() => {});

      // Broadcast to SSE clients (for web UI)
      if (worker && worker.sseBroadcaster) {
        worker.sseBroadcaster.broadcast({
          type: 'new_summary',
          summary: {
            id: summaryId,
            session_id: session.claudeSessionId,
            request: summary.request,
            investigated: summary.investigated,
            learned: summary.learned,
            completed: summary.completed,
            next_steps: summary.next_steps,
            notes: summary.notes,
            project: session.project,
            prompt_number: session.lastPromptNumber,
            created_at_epoch: createdAtEpoch
          }
        });
      }

      logger.info('SDK', 'Summary saved', { summaryId });
    }

    // Check and stop spinner after processing (debounced)
    if (worker && typeof worker.checkAndStopSpinner === 'function') {
      worker.checkAndStopSpinner();
    }
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  /**
   * Find Claude executable (inline, called once per session)
   */
  private findClaudeExecutable(): string {
    const claudePath = process.env.CLAUDE_CODE_PATH ||
      execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf8' })
        .trim().split('\n')[0].trim();

    if (!claudePath) {
      throw new Error('Claude executable not found in PATH');
    }

    return claudePath;
  }

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    try {
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const modelId = settings.env?.CLAUDE_MEM_MODEL;
        if (modelId) return modelId;
      }
    } catch {
      // Fall through to env var or default
    }

    return process.env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5';
  }

  /**
   * Run a filter query using persistent JIT session
   * Sends filter request to running JIT session and waits for response
   */
  async runFilterQuery(sessionDbId: number, userPrompt: string): Promise<number[]> {
    try {
      const queue = this.jitFilterQueues.get(sessionDbId);
      if (!queue) {
        logger.warn('SDK', 'No JIT session for filter query', { sessionDbId });
        return []; // Return empty if JIT session not available
      }

      // Create promise for this filter request
      const resultPromise = new Promise<number[]>((resolve, reject) => {
        queue.requests.push({
          userPrompt,
          resolve,
          reject
        });

        // Notify generator that new request is available
        queue.emitter.emit('request');
      });

      // Wait for response (with timeout)
      const timeout = 30000; // 30 second timeout
      const timeoutPromise = new Promise<number[]>((_, reject) => {
        setTimeout(() => reject(new Error('JIT filter query timeout')), timeout);
      });

      const selectedIds = await Promise.race([resultPromise, timeoutPromise]);

      logger.debug('SDK', 'JIT filter query completed', {
        sessionDbId,
        selectedCount: selectedIds.length
      });

      return selectedIds;
    } catch (error: any) {
      logger.failure('SDK', 'JIT filter query failed', { sessionDbId }, error);
      return []; // Return empty array on error (graceful degradation)
    }
  }

  /**
   * Cleanup JIT session resources
   */
  cleanupJitSession(sessionDbId: number): void {
    const queue = this.jitFilterQueues.get(sessionDbId);
    if (queue) {
      // Reject any pending requests
      queue.requests.forEach(req => {
        req.reject(new Error('JIT session aborted'));
      });
      queue.requests = [];

      // Remove queue
      this.jitFilterQueues.delete(sessionDbId);

      logger.debug('SDK', 'JIT session cleaned up', { sessionDbId });
    }
  }

  /**
   * Get emoji for observation type
   */
  private getTypeEmoji(type: string): string {
    const emojiMap: Record<string, string> = {
      'bugfix': '🔴',
      'feature': '🟣',
      'refactor': '🔄',
      'change': '✅',
      'discovery': '🔵',
      'decision': '🧠'
    };
    return emojiMap[type] || '📝';
  }
}

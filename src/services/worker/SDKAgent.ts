/**
 * SDKAgent: Single-message processing handler
 *
 * Responsibility:
 * - Process one queue message at a time via Agent SDK
 * - Parse SDK responses (observations, summaries)
 * - Sync to database and Chroma
 */

import { homedir } from 'os';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { ActiveSession, SDKUserMessage } from '../worker-types.js';
import type { QueueMessage } from '../queue/types.js';
import { ModeManager } from '../domain/ModeManager.js';

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
   * Process a single message from the SimpleQueue
   * This is the new simplified processing path - one message at a time.
   *
   * @param session Active session to process the message for
   * @param message Queue message to process
   * @param worker WorkerService reference for SSE broadcasting
   */
  async processMessage(session: ActiveSession, message: QueueMessage, worker?: any): Promise<void> {
    try {
      const modelId = this.getModelId();
      const mode = ModeManager.getInstance().getActiveMode();

      // Memory agent is OBSERVER ONLY - no tools allowed
      const disallowedTools = [
        'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob',
        'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
        'AskUserQuestion', 'TodoWrite'
      ];

      // Build prompt for this single message
      let prompt: string;
      if (message.message_type === 'observation') {
        prompt = buildObservationPrompt({
          id: 0,
          tool_name: message.tool_name || 'unknown',
          tool_input: message.tool_input || '{}',
          tool_output: message.tool_response || '{}',
          created_at_epoch: message.created_at_epoch,
          cwd: message.cwd || undefined
        });

        // Update prompt number if provided
        if (message.prompt_number !== null) {
          session.lastPromptNumber = message.prompt_number;
        }
      } else {
        // summarize
        prompt = buildSummaryPrompt({
          id: session.sessionDbId,
          sdk_session_id: session.sdkSessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_user_message: message.last_user_message || '',
          last_assistant_message: message.last_assistant_message || ''
        }, mode);
      }

      // Add to shared conversation history for provider interop
      session.conversationHistory.push({ role: 'user', content: prompt });

      // Create a single-message generator
      const messageGenerator = this.createSingleMessageGenerator(session, prompt);

      logger.info('SDK', 'Processing single message', {
        messageId: message.id,
        type: message.message_type,
        sessionDbId: session.sessionDbId,
        claudeSessionId: session.claudeSessionId,
        promptNumber: session.lastPromptNumber
      });

      // Run Agent SDK query
      const queryResult = query({
        prompt: messageGenerator,
        options: {
          model: modelId,
          resume: session.claudeSessionId,
          disallowedTools,
          abortController: session.abortController
        }
      });

      // Process SDK messages
      for await (const sdkMessage of queryResult) {
        if (sdkMessage.type === 'assistant') {
          const content = sdkMessage.message.content;
          const textContent = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : typeof content === 'string' ? content : '';

          // Track token usage
          const usage = sdkMessage.message.usage;
          if (usage) {
            session.cumulativeInputTokens += usage.input_tokens || 0;
            session.cumulativeOutputTokens += usage.output_tokens || 0;
            if (usage.cache_creation_input_tokens) {
              session.cumulativeInputTokens += usage.cache_creation_input_tokens;
            }
          }

          // Calculate discovery tokens
          const discoveryTokens = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);

          if (textContent.length > 0) {
            // Add to conversation history
            session.conversationHistory.push({ role: 'assistant', content: textContent });

            logger.dataOut('SDK', `Response received (${textContent.length} chars)`, {
              sessionId: session.sessionDbId,
              messageId: message.id
            }, textContent.substring(0, 100));

            // Parse and store observations/summaries
            await this.processSDKResponseForMessage(session, textContent, worker, discoveryTokens, message.created_at_epoch);
          }
        }
      }

      logger.success('SDK', 'Message processed', {
        messageId: message.id,
        type: message.message_type,
        sessionId: session.sessionDbId
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'Message processing aborted', { messageId: message.id });
      } else {
        logger.failure('SDK', 'Message processing error', { messageId: message.id }, error);
      }
      throw error;
    }
  }

  /**
   * Create a single-message generator for the Agent SDK
   */
  private async *createSingleMessageGenerator(session: ActiveSession, prompt: string): AsyncIterableIterator<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: prompt
      },
      session_id: session.claudeSessionId,
      parent_tool_use_id: null,
      isSynthetic: true
    };
  }

  /**
   * Process SDK response for a single message (simplified version)
   * Stores observations and summaries to database and Chroma.
   */
  private async processSDKResponseForMessage(
    session: ActiveSession,
    text: string,
    worker: any | undefined,
    discoveryTokens: number,
    originalTimestamp: number
  ): Promise<void> {
    // Parse observations
    const observations = parseObservations(text, session.claudeSessionId);

    for (const obs of observations) {
      const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp
      );

      logger.info('SDK', 'Observation saved', {
        sessionId: session.sessionDbId,
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      });

      // Sync to Chroma (async, don't block)
      this.dbManager.getChromaSync().syncObservation(
        obsId,
        session.claudeSessionId,
        session.project,
        obs,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).catch((error) => {
        logger.warn('CHROMA', 'Observation sync failed', { obsId }, error);
      });

      // Broadcast to SSE clients
      if (worker?.sseBroadcaster) {
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
    }

    // Parse summary
    const summary = parseSummary(text, session.sessionDbId);

    if (summary) {
      const { id: summaryId, createdAtEpoch } = this.dbManager.getSessionStore().storeSummary(
        session.claudeSessionId,
        session.project,
        summary,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp
      );

      logger.info('SDK', 'Summary saved', {
        sessionId: session.sessionDbId,
        summaryId,
        request: summary.request || '(no request)'
      });

      // Sync to Chroma (async, don't block)
      this.dbManager.getChromaSync().syncSummary(
        summaryId,
        session.claudeSessionId,
        session.project,
        summary,
        session.lastPromptNumber,
        createdAtEpoch,
        discoveryTokens
      ).catch((error) => {
        logger.warn('CHROMA', 'Summary sync failed', { summaryId }, error);
      });

      // Broadcast to SSE clients
      if (worker?.sseBroadcaster) {
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
    }
  }

  // ============================================================================
  // Configuration Helpers
  // ============================================================================

  // Note: pathToClaudeCodeExecutable is optional and handled automatically by the Agent SDK.
  // Ref: https://platform.claude.com/docs/en/agent-sdk/typescript#types

  /**
   * Get model ID from settings or environment
   */
  private getModelId(): string {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_MODEL;
  }
}

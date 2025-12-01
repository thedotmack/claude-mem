/**
 * Summary Hook - Stop
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync, existsSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  [key: string]: any;
}

/**
 * Extract last user message from transcript JSONL file
 */
function extractLastUserMessage(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return '';
    }

    const lines = content.split('\n');

    // Parse JSONL and find last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);

        // Claude Code transcript format: {type: "user", message: {role: "user", content: [...]}}
        if (line.type === 'user' && line.message?.content) {
          const content = line.message.content;

          // Extract text content (handle both string and array formats)
          if (typeof content === 'string') {
            return content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            return textParts.join('\n');
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

/**
 * Extract last assistant message from transcript JSONL file
 * Filters out system-reminder tags to avoid polluting summaries
 */
function extractLastAssistantMessage(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return '';
    }

    const lines = content.split('\n');

    // Parse JSONL and find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);

        // Claude Code transcript format: {type: "assistant", message: {role: "assistant", content: [...]}}
        if (line.type === 'assistant' && line.message?.content) {
          let text = '';
          const content = line.message.content;

          // Extract text content (handle both string and array formats)
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            text = textParts.join('\n');
          }

          // Filter out system-reminder tags and their content
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

          // Clean up excessive whitespace
          text = text.replace(/\n{3,}/g, '\n\n').trim();

          return text;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

/**
 * Summary Hook Main Logic
 */
async function summaryHook(input?: StopInput): Promise<void> {
  if (!input) {
    const errorMsg = 'summaryHook requires input';
    console.error(`[summary-hook] ${errorMsg}`);
    console.log(createHookResponse('Stop', false, { reason: errorMsg }));
    process.exit(1);
  }

  const { session_id, transcript_path } = input;

  // Ensure worker is running
  await ensureWorkerRunning();

  const db = new SessionStore();

  // Get or create session
  const sessionDbId = db.createSDKSession(session_id, '', '');
  const promptNumber = db.getPromptCounter(sessionDbId);

  // Skip summary if user prompt was entirely private
  // This respects the user's intent: if they marked the entire prompt as <private>,
  // they don't want ANY memory operations including summaries
  const userPrompt = db.getUserPrompt(session_id, promptNumber);
  if (!userPrompt || userPrompt.trim() === '') {
    silentDebug('[summary-hook] Skipping summary - user prompt was entirely private', {
      session_id,
      promptNumber
    });
    db.close();
    console.log(createHookResponse('Stop', true));
    return;
  }

  // DIAGNOSTIC: Check session and observations
  const sessionInfo = db.db.prepare(`
    SELECT id, claude_session_id, sdk_session_id, project
    FROM sdk_sessions WHERE id = ?
  `).get(sessionDbId) as any;

  const obsCount = db.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations
    WHERE sdk_session_id = ?
  `).get(sessionInfo?.sdk_session_id) as { count: number };

  happy_path_error__with_fallback('[summary-hook] Session diagnostics', {
    claudeSessionId: session_id,
    sessionDbId,
    sdkSessionId: sessionInfo?.sdk_session_id,
    project: sessionInfo?.project,
    promptNumber,
    observationCount: obsCount?.count || happy_path_error__with_fallback('summary-hook: obsCount.count is null', { sessionDbId }, 0),
    transcriptPath: input.transcript_path
  });

  db.close();

  const port = getWorkerPort();

  // Extract last user AND assistant messages from transcript
  const lastUserMessage = extractLastUserMessage(input.transcript_path || happy_path_error__with_fallback('summary-hook: transcript_path missing for extractLastUserMessage', { session_id__from_hook }));
  const lastAssistantMessage = extractLastAssistantMessage(input.transcript_path || happy_path_error__with_fallback('summary-hook: transcript_path missing for extractLastAssistantMessage', { session_id__from_hook }));

  happy_path_error__with_fallback('[summary-hook] Extracted messages', {
    hasLastUserMessage: !!lastUserMessage,
    hasLastAssistantMessage: !!lastAssistantMessage,
    lastAssistantPreview: lastAssistantMessage.substring(0, 200),
    lastAssistantLength: lastAssistantMessage.length
  });

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    sessionId: sessionDbId,
    workerPort: port,
    promptNumber,
    hasLastUserMessage: !!lastUserMessage,
    hasLastAssistantMessage: !!lastAssistantMessage
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt_number: promptNumber,
        last_user_message: lastUserMessage,
        last_assistant_message: lastAssistantMessage
      }),
      signal: AbortSignal.timeout(
        parseInt(
          process.env.CLAUDE_MEM_SUMMARY_TIMEOUT_MS ||
          (happy_path_error__with_fallback('CLAUDE_MEM_SUMMARY_TIMEOUT_MS not set, using default 90000ms'), '90000'),
          10
        )
      )
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to generate summary', {
        sessionId: sessionDbId,
        status: response.status
      }, errorText);
      const errorMsg = `Failed to request summary from worker: ${response.status} ${errorText}`;
      console.error(`[summary-hook] ${errorMsg}`);
      console.log(createHookResponse('Stop', false, { reason: errorMsg }));
      process.exit(1);
    }

    const result = await response.json();
    console.log('[summary-hook] ✅ Summary queued successfully');
    logger.debug('HOOK', 'Summary request sent successfully', { sessionId: sessionDbId });
  } catch (error: any) {
    // Worker connection/timeout errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      const errorMsg = "There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue";
      console.error(`[summary-hook] ${errorMsg}`);
      console.log(createHookResponse('Stop', false, { reason: errorMsg }));
      process.exit(1);
    }

    // Other errors (HTTP, etc.)
    console.error(`[summary-hook] Failed to trigger summary: ${error.message}`);
    console.log(createHookResponse('Stop', false, { reason: error.message }));
    process.exit(1);
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/processing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isProcessing: false })
    });
  }

  console.log(createHookResponse('Stop', true));
  process.exit(0);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    const parsed = input ? JSON.parse(input) : undefined;
    await summaryHook(parsed);
  } catch (error: any) {
    // Top-level error handler: stderr + JSON + exit 1 (non-blocking - allows session to stop)
    console.error(`[summary-hook] Unhandled error: ${error.message}`);
    console.log(createHookResponse('Stop', false, { reason: error.message }));
    process.exit(1);
  }
});

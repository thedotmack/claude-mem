/**
 * Summary Hook - Stop
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations
 * including privacy checks. This allows the hook to run under any runtime
 * (Node.js or Bun) since it has no native module dependencies.
 *
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 */

import { stdin } from 'process';
import { readFileSync, existsSync } from 'fs';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';

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
 * Summary Hook Main Logic - Fire-and-forget HTTP client
 */
async function summaryHook(input?: StopInput): Promise<void> {
  if (!input) {
    throw new Error('summaryHook requires input');
  }

  const { session_id } = input;

  // Ensure worker is running
  await ensureWorkerRunning();

  const port = getWorkerPort();

  // Extract last user AND assistant messages from transcript
  const lastUserMessage = extractLastUserMessage(input.transcript_path || '');
  const lastAssistantMessage = extractLastAssistantMessage(input.transcript_path || '');

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    workerPort: port,
    hasLastUserMessage: !!lastUserMessage,
    hasLastAssistantMessage: !!lastAssistantMessage
  });

  try {
    // Send to worker - worker handles privacy check and database operations
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        last_user_message: lastUserMessage,
        last_assistant_message: lastAssistantMessage
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to generate summary', {
        status: response.status
      }, errorText);
      throw new Error(`Failed to request summary from worker: ${response.status} ${errorText}`);
    }

    logger.debug('HOOK', 'Summary request sent successfully');
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    throw error;
  } finally {
    // Notify worker to stop spinner (fire-and-forget)
    fetch(`http://127.0.0.1:${port}/api/processing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isProcessing: false })
    }).catch(() => {});
  }

  console.log(createHookResponse('Stop', true));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await summaryHook(parsed);
});

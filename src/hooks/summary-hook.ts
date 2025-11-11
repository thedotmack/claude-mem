/**
 * Summary Hook - Stop
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync, existsSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
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
        if (line.role === 'user' && line.content) {
          // Extract text content (handle both string and array formats)
          if (typeof line.content === 'string') {
            return line.content;
          } else if (Array.isArray(line.content)) {
            const textParts = line.content
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
 * Summary Hook Main Logic
 */
async function summaryHook(input?: StopInput): Promise<void> {
  if (!input) {
    throw new Error('summaryHook requires input');
  }

  const { session_id } = input;

  // Ensure worker is running
  await ensureWorkerRunning();

  const db = new SessionStore();

  // Get or create session
  const sessionDbId = db.createSDKSession(session_id, '', '');
  const promptNumber = db.getPromptCounter(sessionDbId);
  db.close();

  const port = getWorkerPort();

  // Extract last user message from transcript
  const lastUserMessage = extractLastUserMessage(input.transcript_path || '');

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    sessionId: sessionDbId,
    workerPort: port,
    promptNumber,
    hasLastUserMessage: !!lastUserMessage
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt_number: promptNumber,
        last_user_message: lastUserMessage
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to generate summary', {
        sessionId: sessionDbId,
        status: response.status
      }, errorText);
      throw new Error(`Failed to request summary from worker: ${response.status} ${errorText}`);
    }

    logger.debug('HOOK', 'Summary request sent successfully', { sessionId: sessionDbId });
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    // Re-throw HTTP errors and other errors as-is
    throw error;
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/processing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isProcessing: false })
    });
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

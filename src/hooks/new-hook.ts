/**
 * New Hook - UserPromptSubmit
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import path from 'path';
import { stdin } from 'process';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { silentDebug } from '../utils/silent-debug.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

/**
 * New Hook Main Logic - Fire-and-forget HTTP client
 */
async function newHook(input?: UserPromptSubmitInput): Promise<void> {
  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;

  silentDebug('[new-hook] Input received', {
    session_id,
    cwd,
    prompt_length: prompt?.length
  });

  const project = path.basename(cwd);

  // Ensure worker is running
  await ensureWorkerRunning();

  const port = getWorkerPort();

  try {
    // Send to worker - worker handles all database operations
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        project,
        userPrompt: prompt
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize session: ${response.status} ${errorText}`);
    }

    const result = await response.json() as { sessionDbId: number; promptNumber: number };
    console.error(`[new-hook] Session ${result.sessionDbId}, prompt #${result.promptNumber}`);
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    throw error;
  }

  console.log(createHookResponse('UserPromptSubmit', true));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await newHook(parsed);
});

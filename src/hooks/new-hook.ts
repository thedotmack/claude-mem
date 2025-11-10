/**
 * New Hook - UserPromptSubmit
 * Consolidated entry point + logic with optional JIT context filtering
 */

import path from 'path';
import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { isJitContextEnabled } from '../shared/settings.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

/**
 * New Hook Main Logic
 */
async function newHook(input?: UserPromptSubmitInput): Promise<void> {
  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;
  const project = path.basename(cwd);

  // Ensure worker is running
  await ensureWorkerRunning();

  const db = new SessionStore();

  try {
    // Save session_id for indexing
    const sessionDbId = db.createSDKSession(session_id, project, prompt);
    const promptNumber = db.incrementPromptCounter(sessionDbId);

    // Save raw user prompt for full-text search
    db.saveUserPrompt(session_id, promptNumber, prompt);

    console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);

    const port = getWorkerPort();

    // Initialize session via HTTP (with optional JIT context)
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project,
        userPrompt: prompt,
        jitEnabled: isJitContextEnabled()
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize session: ${response.status} ${errorText}`);
    }

    // Extract context from worker response (if JIT was enabled)
    const responseData = await response.json();
    const context = responseData.context || null;

    db.close();

    if (context) {
      // Stringify context for hook response (expects string)
      console.log(createHookResponse('UserPromptSubmit', true, { context: JSON.stringify(context, null, 2) }));
    } else {
      console.log(createHookResponse('UserPromptSubmit', true));
    }
  } catch (error: any) {
    db.close();
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    // Re-throw HTTP errors and other errors as-is
    throw error;
  }
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await newHook(parsed);
});

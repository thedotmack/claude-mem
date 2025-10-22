import path from 'path';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

/**
 * New Hook - UserPromptSubmit
 * Initializes SDK memory session via HTTP POST to worker service
 */
export async function newHook(input?: UserPromptSubmitInput): Promise<void> {
  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;
  const project = path.basename(cwd);

  // Ensure worker is running first (runs cleanup if restarting)
  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    throw new Error('Worker service failed to start or become healthy');
  }

  const db = new SessionStore();

  try {
    // Just save session_id for indexing - no validation, no state management
    const sessionDbId = db.createSDKSession(session_id, project, prompt);
    const promptNumber = db.incrementPromptCounter(sessionDbId);

    // Save raw user prompt for full-text search
    db.saveUserPrompt(session_id, promptNumber, prompt);

    console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);

    // Get fixed port
    const port = getWorkerPort();

    // Initialize session via HTTP
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, userPrompt: prompt }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize session: ${response.status} ${errorText}`);
    }

    console.log(createHookResponse('UserPromptSubmit', true));
  } finally {
    db.close();
  }
}

/**
 * New Hook - UserPromptSubmit
 * Consolidated entry point + logic
 */

import path from 'path';
import { stdin } from 'process';
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
 * New Hook Main Logic
 */
async function newHook(input?: UserPromptSubmitInput): Promise<void> {
  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;
  const project = path.basename(cwd);

  // Ensure worker is running first
  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    throw new Error('Worker service failed to start or become healthy');
  }

  const db = new SessionStore();

  // Save session_id for indexing
  const sessionDbId = db.createSDKSession(session_id, project, prompt);
  const promptNumber = db.incrementPromptCounter(sessionDbId);

  // Save raw user prompt for full-text search
  db.saveUserPrompt(session_id, promptNumber, prompt);

  console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);

  db.close();

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
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await newHook(parsed);
});

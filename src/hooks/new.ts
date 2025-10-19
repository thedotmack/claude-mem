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
  const db = new SessionStore();

  try {
    // Check for any existing session (active, failed, or completed)
    let existing = db.findActiveSDKSession(session_id);
    let sessionDbId: number;
    let isNewSession = false;

    if (existing) {
      // Session already active, increment prompt counter
      sessionDbId = existing.id;
      const promptNumber = db.incrementPromptCounter(sessionDbId);
      console.error(`[new-hook] Continuing session ${sessionDbId}, prompt #${promptNumber}`);
    } else {
      // Check for inactive sessions we can reuse
      const inactive = db.findAnySDKSession(session_id);

      if (inactive) {
        // Reactivate the existing session
        sessionDbId = inactive.id;
        db.reactivateSession(sessionDbId, prompt);
        const promptNumber = db.incrementPromptCounter(sessionDbId);
        isNewSession = true;
        console.error(`[new-hook] Reactivated session ${sessionDbId}, prompt #${promptNumber}`);
      } else {
        // Create new session
        sessionDbId = db.createSDKSession(session_id, project, prompt);
        const promptNumber = db.incrementPromptCounter(sessionDbId);
        isNewSession = true;
        console.error(`[new-hook] Created new session ${sessionDbId}, prompt #${promptNumber}`);
      }
    }

    // Ensure worker service is running (v4.0.0 auto-start)
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      throw new Error('Worker service failed to start or become healthy');
    }

    // Get fixed port
    const port = getWorkerPort();

    // Only initialize worker on new sessions
    if (isNewSession) {
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
    }

    console.log(createHookResponse('UserPromptSubmit', true));
  } finally {
    db.close();
  }
}

import path from 'path';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { createHookResponse } from './hook-response.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

/**
 * Get worker service port from file
 */
async function getWorkerPort(): Promise<number | null> {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');

  const portFile = join(homedir(), '.claude-mem', 'worker.port');

  if (!existsSync(portFile)) {
    return null;
  }

  try {
    const portStr = readFileSync(portFile, 'utf8').trim();
    return parseInt(portStr, 10);
  } catch {
    return null;
  }
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
  const db = new HooksDatabase();

  try {
    // Check for any existing session (active, failed, or completed)
    let existing = db.findActiveSDKSession(session_id);
    let sessionDbId: number;

    if (existing) {
      // Session already active, just continue
      sessionDbId = existing.id;
      console.log(createHookResponse('UserPromptSubmit', true));
      return;
    }

    // Check for inactive sessions we can reuse
    const inactive = db.findAnySDKSession(session_id);

    if (inactive) {
      // Reactivate the existing session
      sessionDbId = inactive.id;
      db.reactivateSession(sessionDbId, prompt);
      console.error(`[new-hook] Reactivated session ${sessionDbId} for Claude session ${session_id}`);
    } else {
      // Create new session
      sessionDbId = db.createSDKSession(session_id, project, prompt);
      console.error(`[new-hook] Created new session ${sessionDbId} for Claude session ${session_id}`);
    }

    // Find worker service port
    const port = await getWorkerPort();
    if (!port) {
      console.error('[new-hook] Worker service not running. Start with: npm run worker:start');
      console.log(createHookResponse('UserPromptSubmit', true)); // Don't block Claude
      return;
    }

    // Initialize session via HTTP
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, userPrompt: prompt }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      console.error('[new-hook] Failed to init session:', await response.text());
    }

    console.log(createHookResponse('UserPromptSubmit', true));
  } catch (error: any) {
    console.error('[new-hook] FATAL ERROR:', error.message);
    console.error('[new-hook] Stack:', error.stack);
    console.error('[new-hook] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    console.log(createHookResponse('UserPromptSubmit', true)); // Don't block Claude
  } finally {
    db.close();
  }
}

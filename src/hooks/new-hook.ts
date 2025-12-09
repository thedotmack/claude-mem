/**
 * New Hook - UserPromptSubmit
 *
 * DUAL PURPOSE HOOK: Handles BOTH session initialization AND continuation
 * ==========================================================================
 *
 * CRITICAL ARCHITECTURE FACTS (NEVER FORGET):
 *
 * 1. SESSION ID THREADING - The Single Source of Truth
 *    - Claude Code assigns ONE session_id per conversation
 *    - ALL hooks in that conversation receive the SAME session_id
 *    - We ALWAYS use this session_id - NEVER generate our own
 *    - This is how NEW hook, SAVE hook, and SUMMARY hook stay connected
 *
 * 2. NO EXISTENCE CHECKS NEEDED
 *    - createSDKSession is idempotent (INSERT OR IGNORE)
 *    - Prompt #1: Creates new database row, returns new ID
 *    - Prompt #2+: Row exists, returns existing ID
 *    - We NEVER need to check "does session exist?" - just use the session_id
 *
 * 3. CONTINUATION LOGIC LOCATION
 *    - This hook does NOT contain continuation prompt logic
 *    - That lives in SDKAgent.ts (lines 125-127)
 *    - SDKAgent checks promptNumber to choose init vs continuation prompt
 *    - BOTH prompts receive the SAME session_id from this hook
 *
 * 4. UNIFIED WITH SAVE HOOK
 *    - SAVE hook uses: db.createSDKSession(session_id, '', '')
 *    - NEW hook uses: db.createSDKSession(session_id, project, prompt)
 *    - Both use session_id from hook context - this keeps everything connected
 *
 * This is KISS in action: Use the session_id we're given, trust idempotent
 * database operations, and let SDKAgent handle init vs continuation logic.
 */

import path from 'path';
import { stdin } from 'process';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';

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
  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;

  // Debug: Log what we received
  happy_path_error__with_fallback('[new-hook] Input received', {
    session_id,
    cwd,
    cwd_type: typeof cwd,
    cwd_length: cwd?.length,
    has_cwd: !!cwd,
    prompt_length: prompt?.length
  });

  const project = path.basename(cwd);

  happy_path_error__with_fallback('[new-hook] Project extracted', {
    project,
    project_type: typeof project,
    project_length: project?.length,
    is_empty: project === '',
    cwd_was: cwd
  });

  const port = getWorkerPort();

  // Initialize session via HTTP - handles DB operations and privacy checks
  let sessionDbId: number;
  let promptNumber: number;

  try {
    const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        project,
        prompt
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Failed to initialize session: ${initResponse.status} ${errorText}`);
    }

    const initResult = await initResponse.json();
    sessionDbId = initResult.sessionDbId;
    promptNumber = initResult.promptNumber;

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber} (fully private - skipped)`);
      console.log(createHookResponse('UserPromptSubmit', true));
      return;
    }

    console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);
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

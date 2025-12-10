import path from 'path';
import { stdin } from 'process';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';
import { handleWorkerError } from '../shared/hook-error-handler.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
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
  const project = path.basename(cwd);

  happy_path_error__with_fallback('[new-hook] Input received', {
    session_id,
    project,
    prompt_length: prompt?.length
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
    handleWorkerError(error);
  }

  // Strip leading slash from commands for memory agent
  // /review 101 → review 101 (more semantic for observations)
  const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

  try {
    // Initialize SDK agent session via HTTP (starts the agent!)
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to start SDK agent: ${response.status} ${errorText}`);
    }
  } catch (error: any) {
    handleWorkerError(error);
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

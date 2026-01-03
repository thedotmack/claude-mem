import { stdin } from 'process';
import { STANDARD_HOOK_RESPONSE } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { getProjectName } from '../utils/project-name.js';
import { logger } from '../utils/logger.js';

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
  const project = getProjectName(cwd);

  logger.info('HOOK', 'new-hook: Received hook input', { session_id, has_prompt: !!prompt, cwd });

  const port = getWorkerPort();

  logger.info('HOOK', 'new-hook: Calling /api/sessions/init', { contentSessionId: session_id, project, prompt_length: prompt?.length });

  // Initialize session via HTTP - handles DB operations and privacy checks
  const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contentSessionId: session_id,
      project,
      prompt
    })
    // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
  });

  if (!initResponse.ok) {
    throw new Error(`Session initialization failed: ${initResponse.status}`);
  }

  const initResult = await initResponse.json();
  const sessionDbId = initResult.sessionDbId;
  const promptNumber = initResult.promptNumber;

  logger.info('HOOK', 'new-hook: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped });

  // SESSION ALIGNMENT LOG: Entry point showing content session ID and prompt number
  logger.info('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${session_id} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

  // Check if prompt was entirely private (worker performs privacy check)
  if (initResult.skipped && initResult.reason === 'private') {
    logger.info('HOOK', `new-hook: Session ${sessionDbId}, prompt #${promptNumber} (fully private - skipped)`);
    console.log(STANDARD_HOOK_RESPONSE);
    return;
  }

  logger.info('HOOK', `new-hook: Session ${sessionDbId}, prompt #${promptNumber}`);

  // Strip leading slash from commands for memory agent
  // /review 101 → review 101 (more semantic for observations)
  const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

  logger.info('HOOK', 'new-hook: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber, userPrompt_length: cleanedPrompt?.length });

  // Initialize SDK agent session via HTTP (starts the agent!)
  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
    // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
  });

  if (!response.ok) {
    throw new Error(`SDK agent start failed: ${response.status}`);
  }

  console.log(STANDARD_HOOK_RESPONSE);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    let parsed: UserPromptSubmitInput | undefined;
    try {
      parsed = input ? JSON.parse(input) : undefined;
    } catch (error) {
      throw new Error(`Failed to parse hook input: ${error instanceof Error ? error.message : String(error)}`);
    }
    await newHook(parsed);
  } catch (error) {
    logger.error('HOOK', 'new-hook failed', {}, error as Error);
  } finally {
    process.exit(0);
  }
});

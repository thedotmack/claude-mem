import { stdin } from 'process';
import { STANDARD_HOOK_RESPONSE } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { getProjectName } from '../utils/project-name.js';
import { logger } from '../utils/logger.js';

export interface UserPromptSubmitInput {
  session_id?: string;
  conversation_id?: string; // Cursor sends conversation_id instead of session_id
  cwd: string;
  prompt: string;
}

/**
 * New Hook Main Logic
 */
async function newHook(input?: UserPromptSubmitInput): Promise<void> {
  await ensureWorkerRunning();

  if (!input) {
    throw new Error('newHook requires input');
  }

  const { cwd, prompt } = input;
  // Cursor sends conversation_id instead of session_id; fall back gracefully
  const session_id = input.session_id ?? input.conversation_id;

  // Skip gracefully if no session ID is available (e.g. Cursor running claude-code hooks)
  if (!session_id) {
    logger.debug('HOOK', 'new-hook: Skipping - no session_id or conversation_id available');
    console.log(STANDARD_HOOK_RESPONSE);
    return;
  }

  const project = getProjectName(cwd);

  logger.info('HOOK', 'new-hook: Received hook input', { session_id, has_prompt: !!prompt, cwd });

  const port = getWorkerPort();

  logger.info('HOOK', 'new-hook: Calling /api/sessions/init', { contentSessionId: session_id, project, prompt_length: prompt?.length });

  const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contentSessionId: session_id,
      project,
      prompt
    })
  });

  if (!initResponse.ok) {
    throw new Error(`Session initialization failed: ${initResponse.status}`);
  }

  const initResult = await initResponse.json();
  const sessionDbId = initResult.sessionDbId;
  const promptNumber = initResult.promptNumber;

  logger.info('HOOK', 'new-hook: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped });

  if (initResult.skipped && initResult.reason === 'private') {
    logger.info('HOOK', `new-hook: Session ${sessionDbId}, prompt #${promptNumber} (fully private - skipped)`);
    console.log(STANDARD_HOOK_RESPONSE);
    return;
  }

  logger.info('HOOK', `new-hook: Session ${sessionDbId}, prompt #${promptNumber}`);

  const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

  logger.info('HOOK', 'new-hook: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber, userPrompt_length: cleanedPrompt?.length });

  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
  });

  if (!response.ok) {
    throw new Error(`SDK agent start failed: ${response.status}`);
  }

  console.log(STANDARD_HOOK_RESPONSE);
}

let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  let parsed: UserPromptSubmitInput | undefined;
  try {
    parsed = input ? JSON.parse(input) : undefined;
  } catch (error) {
    throw new Error(`Failed to parse hook input: ${error instanceof Error ? error.message : String(error)}`);
  }
  await newHook(parsed);
});

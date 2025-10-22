import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning } from '../shared/worker-utils.js';

export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_output: any;
  [key: string]: any;
}

// Tools to skip (low value or too frequent)
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool'
]);

/**
 * Save Hook - PostToolUse
 * Sends tool observations to worker via HTTP POST
 */
export async function saveHook(input?: PostToolUseInput): Promise<void> {
  if (!input) {
    throw new Error('saveHook requires input');
  }

  const { session_id, tool_name, tool_input, tool_output } = input;

  if (SKIP_TOOLS.has(tool_name)) {
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // Ensure worker is running first (runs cleanup if restarting)
  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    throw new Error('Worker service failed to start or become healthy');
  }

  const db = new SessionStore();

  // Get or create session - no validation, just use the session_id from hook
  const sessionDbId = db.createSDKSession(session_id, '', ''); // project and prompt not needed for observations
  const promptNumber = db.getPromptCounter(sessionDbId);
  db.close();

  const toolStr = logger.formatTool(tool_name, tool_input);

  // Use fixed worker port - no session.worker_port validation needed
  const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    sessionId: sessionDbId,
    workerPort: FIXED_PORT
  });

  const response = await fetch(`http://127.0.0.1:${FIXED_PORT}/sessions/${sessionDbId}/observations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool_name,
      tool_input: tool_input !== undefined ? JSON.stringify(tool_input) : '{}',
      tool_output: tool_output !== undefined ? JSON.stringify(tool_output) : '{}',
      prompt_number: promptNumber
    }),
    signal: AbortSignal.timeout(2000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.failure('HOOK', 'Failed to send observation', {
      sessionId: sessionDbId,
      status: response.status
    }, errorText);
    throw new Error(`Failed to send observation to worker: ${response.status} ${errorText}`);
  }

  logger.debug('HOOK', 'Observation sent successfully', { sessionId: sessionDbId, toolName: tool_name });
  console.log(createHookResponse('PostToolUse', true));
}

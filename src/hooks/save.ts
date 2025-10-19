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

  const db = new SessionStore();
  const session = db.findActiveSDKSession(session_id);

  if (!session) {
    db.close();
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  if (!session.worker_port) {
    db.close();
    logger.error('HOOK', 'No worker port for session', { sessionId: session.id });
    throw new Error('No worker port for session - session may not be properly initialized');
  }

  // Get current prompt number for this session
  const promptNumber = db.getPromptCounter(session.id);
  db.close();

  // Ensure worker is running before sending observation
  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    throw new Error('Worker service failed to start or become healthy');
  }

  const toolStr = logger.formatTool(tool_name, tool_input);

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    sessionId: session.id,
    workerPort: session.worker_port
  });

  const response = await fetch(`http://127.0.0.1:${session.worker_port}/sessions/${session.id}/observations`, {
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
      sessionId: session.id,
      status: response.status
    }, errorText);
    throw new Error(`Failed to send observation to worker: ${response.status} ${errorText}`);
  }

  logger.debug('HOOK', 'Observation sent successfully', { sessionId: session.id, toolName: tool_name });
  console.log(createHookResponse('PostToolUse', true));
}

import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning } from '../shared/worker-utils.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  [key: string]: any;
}

/**
 * Summary Hook - Stop
 * Sends SUMMARIZE message to worker via HTTP POST (not finalize - keeps SDK agent running)
 */
export async function summaryHook(input?: StopInput): Promise<void> {
  if (!input) {
    throw new Error('summaryHook requires input');
  }

  const { session_id } = input;

  // Ensure worker is running first (runs cleanup if restarting)
  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    throw new Error('Worker service failed to start or become healthy');
  }

  const db = new SessionStore();
  const session = db.findActiveSDKSession(session_id);

  if (!session) {
    db.close();
    console.log(createHookResponse('Stop', true));
    return;
  }

  if (!session.worker_port) {
    db.close();
    logger.error('HOOK', 'No worker port for session', { sessionId: session.id });
    throw new Error('No worker port for session - session may not be properly initialized');
  }

  // Get current prompt number
  const promptNumber = db.getPromptCounter(session.id);
  db.close();

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    sessionId: session.id,
    workerPort: session.worker_port,
    promptNumber
  });

  const response = await fetch(`http://127.0.0.1:${session.worker_port}/sessions/${session.id}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt_number: promptNumber }),
    signal: AbortSignal.timeout(2000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.failure('HOOK', 'Failed to generate summary', {
      sessionId: session.id,
      status: response.status
    }, errorText);
    throw new Error(`Failed to request summary from worker: ${response.status} ${errorText}`);
  }

  logger.debug('HOOK', 'Summary request sent successfully', { sessionId: session.id });
  console.log(createHookResponse('Stop', true));
}

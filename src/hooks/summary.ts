import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { createHookResponse } from './hook-response.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  [key: string]: any;
}

/**
 * Summary Hook - Stop
 * Sends FINALIZE message to worker via HTTP POST
 */
export async function summaryHook(input?: StopInput): Promise<void> {
  if (!input) {
    throw new Error('summaryHook requires input');
  }

  const { session_id } = input;
  const db = new HooksDatabase();
  const session = db.findActiveSDKSession(session_id);
  db.close();

  if (!session) {
    console.log(createHookResponse('Stop', true));
    return;
  }

  if (!session.worker_port) {
    console.error('[summary-hook] No worker port for session', session.id);
    console.log(createHookResponse('Stop', true));
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${session.worker_port}/sessions/${session.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      console.error('[summary-hook] Failed to finalize:', await response.text());
    }
  } catch (error: any) {
    console.error('[summary-hook] Error:', error.message);
  } finally {
    console.log(createHookResponse('Stop', true));
  }
}

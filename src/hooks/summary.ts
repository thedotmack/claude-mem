import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { createHookResponse } from './hook-response.js';

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
  const db = new HooksDatabase();
  const session = db.findActiveSDKSession(session_id);

  if (!session) {
    db.close();
    console.log(createHookResponse('Stop', true));
    return;
  }

  if (!session.worker_port) {
    db.close();
    console.error('[summary-hook] No worker port for session', session.id);
    console.log(createHookResponse('Stop', true));
    return;
  }

  // Get current prompt number
  const promptNumber = db.getPromptCounter(session.id);
  db.close();

  try {
    const response = await fetch(`http://127.0.0.1:${session.worker_port}/sessions/${session.id}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_number: promptNumber }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      console.error('[summary-hook] Failed to generate summary:', await response.text());
    }
  } catch (error: any) {
    console.error('[summary-hook] Error:', error.message);
  } finally {
    console.log(createHookResponse('Stop', true));
  }
}

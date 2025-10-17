import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { createHookResponse } from './hook-response.js';

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
  'TodoWrite',
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

  const db = new HooksDatabase();
  const session = db.findActiveSDKSession(session_id);

  if (!session) {
    db.close();
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  if (!session.worker_port) {
    db.close();
    console.error('[save-hook] No worker port for session', session.id);
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // Get current prompt number for this session
  const promptNumber = db.getPromptCounter(session.id);
  db.close();

  try {
    const response = await fetch(`http://127.0.0.1:${session.worker_port}/sessions/${session.id}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: JSON.stringify(tool_input),
        tool_output: JSON.stringify(tool_output),
        prompt_number: promptNumber
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      console.error('[save-hook] Failed to send observation:', await response.text());
    }
  } catch (error: any) {
    console.error('[save-hook] Error:', error.message);
  } finally {
    console.log(createHookResponse('PostToolUse', true));
  }
}

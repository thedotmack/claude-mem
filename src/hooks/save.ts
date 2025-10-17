import net from 'net';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';
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
 * Sends tool observations to worker via Unix socket
 */
export function saveHook(input?: PostToolUseInput): void {
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
  db.close();

  if (!session) {
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  const socketPath = getWorkerSocketPath(session.id);
  const message = {
    type: 'observation',
    tool_name,
    tool_input: JSON.stringify(tool_input),
    tool_output: JSON.stringify(tool_output)
  };

  const client = net.connect(socketPath, () => {
    client.write(JSON.stringify(message) + '\n');
    client.end();
  });

  let responded = false;
  const respond = () => {
    if (responded) {
      return;
    }
    responded = true;
    console.log(createHookResponse('PostToolUse', true));
  };

  client.on('close', respond);
  client.on('error', respond);
}

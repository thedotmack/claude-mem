import net from 'net';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';
import { createHookResponse } from './hook-response.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  [key: string]: any;
}

/**
 * Summary Hook - Stop
 * Sends FINALIZE message to worker via Unix socket
 */
export function summaryHook(input?: StopInput): void {
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

  const socketPath = getWorkerSocketPath(session.id);
  const message = {
    type: 'finalize'
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
    console.log(createHookResponse('Stop', true));
  };

  client.on('close', respond);
  client.on('error', respond);
}

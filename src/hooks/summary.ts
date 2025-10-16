import net from 'net';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  [key: string]: any;
}

/**
 * Summary Hook - Stop
 * Sends FINALIZE message to worker via Unix socket
 */
export function summaryHook(input: StopInput): void {
  try {
    const { session_id } = input;

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);
    db.close();

    if (!session) {
      // No active session - nothing to finalize
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Get socket path
    const socketPath = getWorkerSocketPath(session.id);

    // Send FINALIZE message via Unix socket
    const message = {
      type: 'finalize'
    };

    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(message) + '\n');
      client.end();
    });

    client.on('error', (err) => {
      // Socket not available - worker may have already finished or crashed
      console.error(`[claude-mem summary] Socket error: ${err.message}`);
      // Continue anyway, don't block Claude
    });

    client.on('close', () => {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    });

  } catch (error: any) {
    // On error, don't block Claude Code
    console.error(`[claude-mem summary error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

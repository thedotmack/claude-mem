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
export function summaryHook(input?: StopInput): void {
  try {
    // Log hook entry point
    console.error('[claude-mem summary] Hook fired', {
      input: input ? { session_id: input.session_id, cwd: input.cwd } : null
    });

    // Handle standalone execution (no input provided)
    if (!input) {
      console.log('No input provided - this script is designed to run as a Claude Code Stop hook');
      console.log('\nExpected input format:');
      console.log(JSON.stringify({
        session_id: "string",
        cwd: "string"
      }, null, 2));
      process.exit(0);
    }

    const { session_id } = input;
    console.error('[claude-mem summary] Searching for active SDK session', { session_id });

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);
    db.close();

    if (!session) {
      // No active session - nothing to finalize
      console.error('[claude-mem summary] No active SDK session found', { session_id });
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    console.error('[claude-mem summary] Active SDK session found', {
      session_id: session.id,
      collection_name: session.collection_name,
      worker_pid: session.worker_pid
    });

    // Get socket path
    const socketPath = getWorkerSocketPath(session.id);

    // Send FINALIZE message via Unix socket
    const message = {
      type: 'finalize'
    };

    console.error('[claude-mem summary] Attempting to send FINALIZE message to worker socket', {
      socketPath,
      message
    });

    const client = net.connect(socketPath, () => {
      console.error('[claude-mem summary] Socket connection established, sending message');
      client.write(JSON.stringify(message) + '\n');
      client.end();
    });

    client.on('error', (err) => {
      // Socket not available - worker may have already finished or crashed
      console.error('[claude-mem summary] Socket error occurred', {
        error: err.message,
        code: (err as any).code,
        socketPath
      });
      // Continue anyway, don't block Claude
    });

    client.on('close', () => {
      console.error('[claude-mem summary] Socket connection closed successfully');
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    });

  } catch (error: any) {
    // On error, don't block Claude Code
    console.error('[claude-mem summary] Unexpected error in hook', {
      error: error.message,
      stack: error.stack,
      name: error.name
    });
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

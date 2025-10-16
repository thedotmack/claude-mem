import { existsSync, unlinkSync } from 'fs';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/**
 * Cleanup Hook - SessionEnd
 * Cleans up worker process and marks session as terminated
 *
 * This hook runs when a Claude Code session ends. It:
 * 1. Finds active SDK session for this Claude session
 * 2. Terminates worker process if still running
 * 3. Removes stale socket file
 * 4. Marks session as failed (since no Stop hook completed it)
 */
export function cleanupHook(input?: SessionEndInput): void {
  try {
    // Log hook entry point
    console.error('[claude-mem cleanup] Hook fired', {
      input: input ? {
        session_id: input.session_id,
        cwd: input.cwd,
        reason: input.reason
      } : null
    });

    // Handle standalone execution (no input provided)
    if (!input) {
      console.log('No input provided - this script is designed to run as a Claude Code SessionEnd hook');
      console.log('\nExpected input format:');
      console.log(JSON.stringify({
        session_id: "string",
        cwd: "string",
        transcript_path: "string",
        hook_event_name: "SessionEnd",
        reason: "exit"
      }, null, 2));
      process.exit(0);
    }

    const { session_id, reason } = input;
    console.error('[claude-mem cleanup] Searching for active SDK session', { session_id, reason });

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);

    if (!session) {
      // No active session - nothing to clean up
      console.error('[claude-mem cleanup] No active SDK session found', { session_id });
      db.close();
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    console.error('[claude-mem cleanup] Active SDK session found', {
      session_id: session.id,
      sdk_session_id: session.sdk_session_id,
      project: session.project
    });

    // Get worker PID and socket path
    const socketPath = getWorkerSocketPath(session.id);

    // 1. Kill worker process if it exists
    try {
      // Try to read PID from socket file existence
      if (existsSync(socketPath)) {
        console.error('[claude-mem cleanup] Socket file exists, attempting cleanup', { socketPath });

        // Remove socket file
        try {
          unlinkSync(socketPath);
          console.error('[claude-mem cleanup] Socket file removed successfully', { socketPath });
        } catch (unlinkErr: any) {
          console.error('[claude-mem cleanup] Failed to remove socket file', {
            error: unlinkErr.message,
            socketPath
          });
        }
      } else {
        console.error('[claude-mem cleanup] Socket file does not exist', { socketPath });
      }

      // Note: We don't kill the worker process here because:
      // 1. Workers have a 2-hour watchdog timer that will kill them automatically
      // 2. Killing by PID is fragile (PID might be reused)
      // 3. The worker will exit on its own when it can't reach the socket
      // We just clean up the socket file to prevent stale socket issues

    } catch (cleanupErr: any) {
      console.error('[claude-mem cleanup] Error during cleanup', {
        error: cleanupErr.message,
        stack: cleanupErr.stack
      });
    }

    // 2. Mark session as failed (since Stop hook didn't complete it)
    try {
      db.markSessionFailed(session.id);
      console.error('[claude-mem cleanup] Session marked as failed', {
        session_id: session.id,
        reason: 'SessionEnd hook - session terminated without completion'
      });
    } catch (markErr: any) {
      console.error('[claude-mem cleanup] Failed to mark session as failed', {
        error: markErr.message,
        session_id: session.id
      });
    }

    db.close();

    console.error('[claude-mem cleanup] Cleanup completed successfully');
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);

  } catch (error: any) {
    // On error, don't block Claude Code exit
    console.error('[claude-mem cleanup] Unexpected error in hook', {
      error: error.message,
      stack: error.stack,
      name: error.name
    });
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

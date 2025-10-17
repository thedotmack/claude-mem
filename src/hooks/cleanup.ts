import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/**
 * Cleanup Hook - SessionEnd
 * Cleans up worker session via HTTP DELETE
 *
 * This hook runs when a Claude Code session ends. It:
 * 1. Finds active SDK session for this Claude session
 * 2. Sends DELETE request to worker service
 * 3. Marks session as failed if not already completed
 */
export async function cleanupHook(input?: SessionEndInput): Promise<void> {
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
      project: session.project,
      worker_port: session.worker_port
    });

    // 1. Delete session via HTTP
    if (session.worker_port) {
      try {
        const response = await fetch(`http://127.0.0.1:${session.worker_port}/sessions/${session.id}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5000)
        });

        if (response.ok) {
          console.error('[claude-mem cleanup] Session deleted successfully via HTTP');
        } else {
          console.error('[claude-mem cleanup] Failed to delete session:', await response.text());
        }
      } catch (error: any) {
        console.error('[claude-mem cleanup] HTTP DELETE error:', error.message);
      }
    } else {
      console.error('[claude-mem cleanup] No worker port, cannot send DELETE request');
    }

    // 2. Mark session as failed in DB (if not already completed)
    try {
      db.markSessionFailed(session.id);
      console.error('[claude-mem cleanup] Session marked as failed in database');
    } catch (markErr: any) {
      console.error('[claude-mem cleanup] Failed to mark session as failed:', markErr);
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

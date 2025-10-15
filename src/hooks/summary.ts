import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  [key: string]: any;
}

/**
 * Summary Hook - Stop
 * Signals SDK to finalize and generate summary
 */
export function summaryHook(input: StopInput): void {
  try {
    const { session_id } = input;

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);

    if (!session) {
      // No active session - nothing to finalize
      db.close();
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Insert special FINALIZE message into observation queue
    const sdkSessionId = session.sdk_session_id || `pending-${session.id}`;

    db.queueObservation(
      sdkSessionId,
      'FINALIZE',
      '{}',
      '{}'
    );

    db.close();

    // Output hook response
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);

  } catch (error: any) {
    // On error, don't block Claude Code
    console.error(`[claude-mem summary error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

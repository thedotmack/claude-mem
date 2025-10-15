import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import path from 'path';

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
 * Queues tool observations for SDK processing
 */
export function saveHook(input: PostToolUseInput): void {
  try {
    const { session_id, cwd, tool_name, tool_input, tool_output } = input;

    // Skip certain tools
    if (SKIP_TOOLS.has(tool_name)) {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Extract project from cwd
    const project = path.basename(cwd);

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);

    if (!session) {
      // No active session yet - this can happen if UserPromptSubmit hasn't run
      // Just exit silently
      db.close();
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Queue the observation
    // SDK session ID might be null if init message hasn't arrived yet
    // Use the internal ID as a fallback
    const sdkSessionId = session.sdk_session_id || `pending-${session.id}`;

    db.queueObservation(
      sdkSessionId,
      tool_name,
      JSON.stringify(tool_input),
      JSON.stringify(tool_output)
    );

    db.close();

    // Output hook response
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);

  } catch (error: any) {
    // On error, don't block Claude Code
    console.error(`[claude-mem save error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

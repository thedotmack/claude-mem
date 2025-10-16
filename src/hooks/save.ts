import net from 'net';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';

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
  try {
    // Handle standalone execution (no input provided)
    if (!input) {
      console.log('No input provided - this script is designed to run as a Claude Code PostToolUse hook');
      console.log('\nExpected input format:');
      console.log(JSON.stringify({
        session_id: "string",
        cwd: "string",
        tool_name: "string",
        tool_input: {},
        tool_output: {}
      }, null, 2));
      process.exit(0);
    }

    const { session_id, tool_name, tool_input, tool_output } = input;

    // Skip certain tools
    if (SKIP_TOOLS.has(tool_name)) {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);
    db.close();

    if (!session) {
      // No active session yet - this can happen if UserPromptSubmit hasn't run
      // Just exit silently
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Get socket path
    const socketPath = getWorkerSocketPath(session.id);

    // Send observation via Unix socket
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

    client.on('error', (err) => {
      // Socket not available - worker may have crashed or not started
      console.error(`[claude-mem save] Socket error: ${err.message}`);
      // Continue anyway, don't block Claude
    });

    client.on('close', () => {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    });

  } catch (error: any) {
    // On error, don't block Claude Code
    console.error(`[claude-mem save error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

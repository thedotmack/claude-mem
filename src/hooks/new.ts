import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import path from 'path';
import { spawn } from 'child_process';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

/**
 * New Hook - UserPromptSubmit
 * Initializes SDK memory session in background
 */
export function newHook(input: UserPromptSubmitInput): void {
  try {
    const { session_id, cwd, prompt } = input;

    // Extract project from cwd
    const project = path.basename(cwd);

    // Check if session already exists
    const db = new HooksDatabase();
    const existing = db.findActiveSDKSession(session_id);

    if (existing) {
      // Session already initialized, just continue
      db.close();
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    // Create SDK session record
    const sessionId = db.createSDKSession(session_id, project, prompt);
    db.close();

    // Start SDK worker in background
    // The SDK worker will be implemented in a separate file
    // For now, we just create the session record

    // TODO: Spawn SDK worker as detached process
    // const workerPath = path.join(__dirname, '..', 'sdk', 'worker.js');
    // const child = spawn('bun', [workerPath, sessionId.toString()], {
    //   detached: true,
    //   stdio: 'ignore'
    // });
    // child.unref();

    // Output hook response
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);

  } catch (error: any) {
    // On error, don't block Claude Code
    console.error(`[claude-mem new error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

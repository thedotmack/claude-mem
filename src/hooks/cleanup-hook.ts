#!/usr/bin/env node
/**
 * Cleanup Hook - SessionEnd
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { ensureWorkerRunning } from '../shared/worker-utils.js';

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/**
 * Cleanup Hook Main Logic
 */
async function cleanupHook(input?: SessionEndInput): Promise<void> {
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

  // Ensure worker is running first
  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    console.error('[claude-mem cleanup] Worker not available - skipping HTTP cleanup');
  }

  // Find active SDK session
  const db = new SessionStore();
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

  // Mark session as completed in DB
  db.markSessionCompleted(session.id);
  console.error('[claude-mem cleanup] Session marked as completed in database');

  db.close();

  console.error('[claude-mem cleanup] Cleanup completed successfully');
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}

// Entry Point
if (stdin.isTTY) {
  // Running manually
  cleanupHook(undefined);
} else {
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    const parsed = input ? JSON.parse(input) : undefined;
    await cleanupHook(parsed);
  });
}

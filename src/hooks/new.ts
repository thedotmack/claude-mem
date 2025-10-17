import { spawn } from 'child_process';
import path from 'path';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { createHookResponse } from './hook-response.js';

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
export function newHook(input?: UserPromptSubmitInput): void {
  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;
  const project = path.basename(cwd);
  const db = new HooksDatabase();

  try {
    const existing = db.findActiveSDKSession(session_id);

    if (existing) {
      console.log(createHookResponse('UserPromptSubmit', true));
      return;
    }

    const sessionId = db.createSDKSession(session_id, project, prompt);

    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

    if (!pluginRoot) {
      throw new Error('CLAUDE_PLUGIN_ROOT not set');
    }

    const workerPath = path.join(pluginRoot, 'scripts', 'hooks', 'worker.js');
    const child = spawn('bun', [workerPath, sessionId.toString()], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();

    console.log(createHookResponse('UserPromptSubmit', true));
  } finally {
    db.close();
  }
}

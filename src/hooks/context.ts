import path from 'path';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { ensureWorkerRunning } from '../shared/worker-utils.js';

export interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

/**
 * Context Hook - SessionStart
 * Shows recent summaries for the project
 */
export function contextHook(input?: SessionStartInput, useColors: boolean = false, useIndexView: boolean = false): string {
  ensureWorkerRunning();
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  try {
    // Query session_summaries directly - no need for sdk_sessions table
    const summaries = db.db.prepare(`
      SELECT sdk_session_id, request, learned, completed, next_steps, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 3
    `).all(project) as Array<{
      sdk_session_id: string;
      request: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      created_at: string;
    }>;

    if (summaries.length === 0) {
      return `# [${project}] recent context\n\nNo previous summaries found for this project yet.`;
    }

    const output: string[] = [];
    output.push(`# [${project}] recent context`);
    output.push('');

    let previousSessionId: string | null = null;

    for (const summary of summaries) {
      const isNewSession = previousSessionId !== null && summary.sdk_session_id !== previousSessionId;

      if (isNewSession) {
        output.push('');
        output.push('--- New Session ---');
        output.push('');
      }

      if (summary.request) output.push(`**Request:** ${summary.request}`);
      if (summary.learned) output.push(`**Learned:** ${summary.learned}`);
      if (summary.completed) output.push(`**Completed:** ${summary.completed}`);
      if (summary.next_steps) output.push(`**Next Steps:** ${summary.next_steps}`);

      // Get files from observations by sdk_session_id
      const observations = db.db.prepare(`
        SELECT files_read, files_modified
        FROM observations
        WHERE sdk_session_id = ?
      `).all(summary.sdk_session_id) as Array<{
        files_read: string | null;
        files_modified: string | null;
      }>;

      const filesReadSet = new Set<string>();
      const filesModifiedSet = new Set<string>();

      for (const obs of observations) {
        if (obs.files_read) {
          try {
            const files = JSON.parse(obs.files_read);
            if (Array.isArray(files)) files.forEach(f => filesReadSet.add(f));
          } catch {}
        }
        if (obs.files_modified) {
          try {
            const files = JSON.parse(obs.files_modified);
            if (Array.isArray(files)) files.forEach(f => filesModifiedSet.add(f));
          } catch {}
        }
      }

      if (filesReadSet.size > 0) {
        output.push(`**Files Read:** ${Array.from(filesReadSet).join(', ')}`);
      }
      if (filesModifiedSet.size > 0) {
        output.push(`**Files Modified:** ${Array.from(filesModifiedSet).join(', ')}`);
      }

      const dateTime = new Date(summary.created_at).toLocaleString();
      output.push(`**Date:** ${dateTime}`);
      output.push('');

      previousSessionId = summary.sdk_session_id;
    }

    return output.join('\n');
  } finally {
    db.close();
  }
}
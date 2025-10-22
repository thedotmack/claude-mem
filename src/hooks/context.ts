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
 * Shows user what happened in recent sessions
 */
export function contextHook(input?: SessionStartInput, useColors: boolean = false, useIndexView: boolean = false): string {
  ensureWorkerRunning();
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  try {
    // Get the most recent summaries, then display them chronologically (oldest to newest, like a chat)
    const summaries = db.db.prepare(`
      SELECT * FROM (
        SELECT sdk_session_id, request, learned, completed, next_steps, created_at
        FROM session_summaries
        WHERE project = ?
        ORDER BY created_at_epoch DESC
        LIMIT 10
      )
      ORDER BY created_at_epoch ASC
    `).all(project) as Array<{
      sdk_session_id: string;
      request: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      created_at: string;
    }>;

    if (summaries.length === 0) {
      if (useColors) {
        return `\n${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous summaries found for this project yet.${colors.reset}\n`;
      }
      return `# [${project}] recent context\n\nNo previous summaries found for this project yet.`;
    }

    const output: string[] = [];

    if (useColors) {
      output.push('');
      output.push(`${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}`);
      output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
    } else {
      output.push(`# [${project}] recent context`);
      output.push('');
    }

    let previousSessionId: string | null = null;
    let isFirstSummary = true;

    for (const summary of summaries) {
      const isNewSession = previousSessionId !== null && summary.sdk_session_id !== previousSessionId;

      if (isNewSession) {
        if (useColors) {
          output.push('');
          output.push(`${colors.dim}${'─'.repeat(23)} New Summary ${'─'.repeat(24)}${colors.reset}`);
          output.push('');
        } else {
          output.push('');
          output.push('---');
          output.push('');
        }
      } else if (!isFirstSummary) {
        if (useColors) {
          output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
          output.push('');
        } else {
          output.push('---');
          output.push('');
        }
      } else {
        if (useColors) {
          output.push('');
        }
      }

      isFirstSummary = false;

      if (summary.request) {
        if (useColors) {
          output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${summary.request}`);
          output.push('');
        } else {
          output.push(`**Request:** ${summary.request}`);
          output.push('');
        }
      }

      if (summary.learned) {
        if (useColors) {
          output.push(`${colors.bright}${colors.blue}Learned:${colors.reset} ${summary.learned}`);
          output.push('');
        } else {
          output.push(`**Learned:** ${summary.learned}`);
          output.push('');
        }
      }

      if (summary.completed) {
        if (useColors) {
          output.push(`${colors.bright}${colors.green}Completed:${colors.reset} ${summary.completed}`);
          output.push('');
        } else {
          output.push(`**Completed:** ${summary.completed}`);
          output.push('');
        }
      }

      if (summary.next_steps) {
        if (useColors) {
          output.push(`${colors.bright}${colors.magenta}Next Steps:${colors.reset} ${summary.next_steps}`);
          output.push('');
        } else {
          output.push(`**Next Steps:** ${summary.next_steps}`);
          output.push('');
        }
      }

      // Get files from observations directly
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
            if (Array.isArray(files)) {
              files.forEach(f => filesReadSet.add(f));
            }
          } catch {
            // Skip invalid JSON
          }
        }

        if (obs.files_modified) {
          try {
            const files = JSON.parse(obs.files_modified);
            if (Array.isArray(files)) {
              files.forEach(f => filesModifiedSet.add(f));
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }

      if (filesReadSet.size > 0) {
        if (useColors) {
          output.push(`${colors.dim}Files Read: ${Array.from(filesReadSet).join(', ')}${colors.reset}`);
        } else {
          output.push(`**Files Read:** ${Array.from(filesReadSet).join(', ')}`);
        }
      }

      if (filesModifiedSet.size > 0) {
        if (useColors) {
          output.push(`${colors.dim}Files Modified: ${Array.from(filesModifiedSet).join(', ')}${colors.reset}`);
        } else {
          output.push(`**Files Modified:** ${Array.from(filesModifiedSet).join(', ')}`);
        }
      }

      const dateTime = new Date(summary.created_at).toLocaleString();
      if (useColors) {
        output.push(`${colors.dim}Date: ${dateTime}${colors.reset}`);
      } else {
        output.push(`**Date:** ${dateTime}`);
      }

      if (!useColors) {
        output.push('');
      }

      previousSessionId = summary.sdk_session_id;
    }

    if (useColors) {
      output.push('');
      output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
    }

    return output.join('\n');
  } finally {
    db.close();
  }
}

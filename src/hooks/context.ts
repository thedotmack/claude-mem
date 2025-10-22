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
        SELECT sdk_session_id, request, learned, completed, next_steps, created_at, created_at_epoch
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

    let isFirstSummary = true;

    for (let i = 0; i < summaries.length; i++) {
      const summary = summaries[i];

      // Determine verbosity tier based on position
      // Most recent summary is at the end (highest index) since we display chronologically
      const positionFromEnd = summaries.length - 1 - i;
      const isTier1 = positionFromEnd === 0; // Most recent (full verbosity)
      const isTier2 = positionFromEnd >= 1 && positionFromEnd <= 3; // Middle 3 (request + what was done)
      const isTier3 = positionFromEnd > 3; // Oldest 6 (request only)

      // Add separator between summaries (but not before the first one)
      if (!isFirstSummary) {
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

      // TIER 3: Minimal (just Request + Date)
      if (isTier3) {
        if (summary.request) {
          if (useColors) {
            output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${summary.request}`);
            output.push('');
          } else {
            output.push(`**Request:** ${summary.request}`);
            output.push('');
          }
        }
        const dateTime = new Date(summary.created_at).toLocaleString();
        if (useColors) {
          output.push(`${colors.dim}Date: ${dateTime}${colors.reset}`);
        } else {
          output.push(`**Date:** ${dateTime}`);
          output.push('');
        }
        continue; // Skip the rest for Tier 3
      }

      // TIER 1 & 2: Show Request
      if (summary.request) {
        if (useColors) {
          output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${summary.request}`);
          output.push('');
        } else {
          output.push(`**Request:** ${summary.request}`);
          output.push('');
        }
      }

      // TIER 1 ONLY: Show Learned
      if (isTier1 && summary.learned) {
        if (useColors) {
          output.push(`${colors.bright}${colors.blue}Learned:${colors.reset} ${summary.learned}`);
          output.push('');
        } else {
          output.push(`**Learned:** ${summary.learned}`);
          output.push('');
        }
      }

      // TIER 1 & 2: Show Completed
      if (summary.completed) {
        if (useColors) {
          output.push(`${colors.bright}${colors.green}Completed:${colors.reset} ${summary.completed}`);
          output.push('');
        } else {
          output.push(`**Completed:** ${summary.completed}`);
          output.push('');
        }
      }

      // TIER 1 ONLY: Show Next Steps
      if (isTier1 && summary.next_steps) {
        if (useColors) {
          output.push(`${colors.bright}${colors.magenta}Next Steps:${colors.reset} ${summary.next_steps}`);
          output.push('');
        } else {
          output.push(`**Next Steps:** ${summary.next_steps}`);
          output.push('');
        }
      }

      // TIER 1 ONLY: Get and show files
      if (isTier1) {
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

        // Helper function to convert absolute paths to relative paths
        const toRelativePath = (filePath: string): string => {
          try {
            // Only convert if it's an absolute path
            if (path.isAbsolute(filePath)) {
              return path.relative(cwd, filePath);
            }
            return filePath;
          } catch {
            return filePath;
          }
        };

        for (const obs of observations) {
          if (obs.files_read) {
            try {
              const files = JSON.parse(obs.files_read);
              if (Array.isArray(files)) {
                files.forEach(f => filesReadSet.add(toRelativePath(f)));
              }
            } catch {
              // Skip invalid JSON
            }
          }

          if (obs.files_modified) {
            try {
              const files = JSON.parse(obs.files_modified);
              if (Array.isArray(files)) {
                files.forEach(f => filesModifiedSet.add(toRelativePath(f)));
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }

        // Remove files from filesReadSet if they're already in filesModifiedSet (avoid redundancy)
        filesModifiedSet.forEach(file => filesReadSet.delete(file));

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
      }

      // TIER 1 & 2: Show Date
      const dateTime = new Date(summary.created_at).toLocaleString();
      if (useColors) {
        output.push(`${colors.dim}Date: ${dateTime}${colors.reset}`);
      } else {
        output.push(`**Date:** ${dateTime}`);
      }

      if (!useColors) {
        output.push('');
      }
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

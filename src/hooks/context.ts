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
 *
 * Output: Returns formatted context string to be wrapped in hookSpecificOutput
 */
export function contextHook(input?: SessionStartInput, useColors: boolean = false, useIndexView: boolean = false): string {
  // v4.0.0: Ensure worker is running before loading context
  ensureWorkerRunning();
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  try {
    const summaries = db.getRecentSummariesWithSessionInfo(project, 3);

    if (summaries.length === 0) {
      if (useColors) {
        return `\n${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous summaries found for this project yet.${colors.reset}\n`;
      }
      return `# [${project}] recent context\n\nNo previous summaries found for this project yet.`;
    }

    const output: string[] = [];

    // Index view: Show previous as index, latest in full at bottom (chat-style)
    if (useIndexView) {
      if (useColors) {
        output.push('');
        output.push(`${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}`);
        output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
        output.push('');
      } else {
        output.push(`# [${project}] recent context`);
        output.push('');
      }

      // Show index of previous summaries (oldest to newest)
      if (summaries.length > 1) {
        if (useColors) {
          output.push(`${colors.bright}${colors.dim}Previous Requests:${colors.reset}`);
          output.push('');
        } else {
          output.push('**Previous Requests:**');
          output.push('');
        }

        // Iterate backwards through array (skip first which is most recent)
        for (let i = summaries.length - 1; i >= 1; i--) {
          const prev = summaries[i];
          const prevDate = new Date(prev.created_at);
          const dateTimeStr = prevDate.toLocaleString();

          if (useColors) {
            output.push(`${colors.dim}• ${dateTimeStr}:${colors.reset} ${prev.request || '(no request)'}`);
          } else {
            output.push(`- ${dateTimeStr}: ${prev.request || '(no request)'}`);
          }
        }

        if (useColors) {
          output.push('');
          output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
          output.push('');
        } else {
          output.push('');
          output.push('---');
          output.push('');
        }
      }

      // Show most recent summary in full at the bottom
      const latest = summaries[0];

      if (latest.request) {
        if (useColors) {
          output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${latest.request}`);
          output.push('');
        } else {
          output.push(`**Request:** ${latest.request}`);
          output.push('');
        }
      }

      if (latest.learned) {
        if (useColors) {
          output.push(`${colors.bright}${colors.blue}Learned:${colors.reset} ${latest.learned}`);
          output.push('');
        } else {
          output.push(`**Learned:** ${latest.learned}`);
          output.push('');
        }
      }

      if (latest.completed) {
        if (useColors) {
          output.push(`${colors.bright}${colors.green}Completed:${colors.reset} ${latest.completed}`);
          output.push('');
        } else {
          output.push(`**Completed:** ${latest.completed}`);
          output.push('');
        }
      }

      if (latest.next_steps) {
        if (useColors) {
          output.push(`${colors.bright}${colors.magenta}Next Steps:${colors.reset} ${latest.next_steps}`);
          output.push('');
        } else {
          output.push(`**Next Steps:** ${latest.next_steps}`);
          output.push('');
        }
      }

      // Get files for latest summary
      const latestFiles = db.getFilesForSession(latest.sdk_session_id);

      if (latestFiles.filesRead.length > 0) {
        if (useColors) {
          output.push(`${colors.dim}Files Read: ${latestFiles.filesRead.join(', ')}${colors.reset}`);
        } else {
          output.push(`**Files Read:** ${latestFiles.filesRead.join(', ')}`);
        }
      }

      if (latestFiles.filesModified.length > 0) {
        if (useColors) {
          output.push(`${colors.dim}Files Modified: ${latestFiles.filesModified.join(', ')}${colors.reset}`);
        } else {
          output.push(`**Files Modified:** ${latestFiles.filesModified.join(', ')}`);
        }
      }

      const latestDate = new Date(latest.created_at).toLocaleString();
      if (useColors) {
        output.push(`${colors.dim}Date: ${latestDate}${colors.reset}`);
      } else {
        output.push(`**Date:** ${latestDate}`);
      }

      if (useColors) {
        output.push('');
        output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
      }

      return output.join('\n');
    }

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
      // Add session break indicator if this is a different session
      const isNewSession = previousSessionId !== null && summary.sdk_session_id !== previousSessionId;

      if (isNewSession) {
        if (useColors) {
          output.push('');
          output.push(`${colors.dim}${'─'.repeat(23)} New Session ${'─'.repeat(24)}${colors.reset}`);
          output.push('');
        } else {
          output.push('');
          output.push('--- New Session ---');
          output.push('');
        }
      } else if (!isFirstSummary) {
        // Only show regular separator if not first summary and not showing "New Session"
        if (useColors) {
          output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
          output.push('');
        } else {
          output.push('---');
          output.push('');
        }
      } else {
        // First summary - just add a blank line after header
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

      // Get files from observations (not from summary which is never populated)
      const sessionFiles = db.getFilesForSession(summary.sdk_session_id);

      if (sessionFiles.filesRead.length > 0) {
        if (useColors) {
          output.push(`${colors.dim}Files Read: ${sessionFiles.filesRead.join(', ')}${colors.reset}`);
        } else {
          output.push(`**Files Read:** ${sessionFiles.filesRead.join(', ')}`);
        }
      }

      if (sessionFiles.filesModified.length > 0) {
        if (useColors) {
          output.push(`${colors.dim}Files Modified: ${sessionFiles.filesModified.join(', ')}${colors.reset}`);
        } else {
          output.push(`**Files Modified:** ${sessionFiles.filesModified.join(', ')}`);
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
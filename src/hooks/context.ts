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
export function contextHook(input?: SessionStartInput, useColors: boolean = false): string {
  // v4.0.0: Ensure worker is running before loading context
  ensureWorkerRunning();
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  try {
    const sessions = db.getRecentSessionsWithStatus(project, 3);

    if (sessions.length === 0) {
      if (useColors) {
        return `\n${colors.bright}${colors.cyan}📝 Recent Session Context${colors.reset}\n\n${colors.dim}No previous sessions found for this project yet.${colors.reset}\n`;
      }
      return '# Recent Session Context\n\nNo previous sessions found for this project yet.';
    }

    const output: string[] = [];

    if (useColors) {
      output.push('');
      output.push(`${colors.bright}${colors.cyan}📝 Recent Session Context${colors.reset}`);
      output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
      output.push(`${colors.dim}Showing last ${sessions.length} session(s) for ${colors.reset}${colors.bright}${project}${colors.reset}`);
      output.push('');
    } else {
      output.push('# Recent Session Context');
      output.push('');
      output.push(`Showing last ${sessions.length} session(s) for **${project}**:`);
      output.push('');
    }

    for (const session of sessions) {
      if (!session.sdk_session_id) continue;

      if (useColors) {
        output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
        output.push('');
      } else {
        output.push('---');
        output.push('');
      }

      // Check if session has a summary
      if (session.has_summary) {
        const summary = db.getSummaryForSession(session.sdk_session_id);

        if (summary) {
          const promptLabel = summary.prompt_number ? ` (Prompt #${summary.prompt_number})` : '';

          if (useColors) {
            output.push(`${colors.bright}${colors.green}✓ Summary${promptLabel}${colors.reset}`);
            output.push('');
          } else {
            output.push(`**Summary${promptLabel}**`);
            output.push('');
          }

          if (summary.request) {
            if (useColors) {
              output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${summary.request}`);
              output.push('');
            } else {
              output.push(`**Request:** ${summary.request}`);
            }
          }

          if (summary.completed) {
            if (useColors) {
              output.push(`${colors.bright}${colors.green}Completed:${colors.reset} ${summary.completed}`);
              output.push('');
            } else {
              output.push(`**Completed:** ${summary.completed}`);
            }
          }

          if (summary.learned) {
            if (useColors) {
              output.push(`${colors.bright}${colors.blue}Learned:${colors.reset} ${summary.learned}`);
              output.push('');
            } else {
              output.push(`**Learned:** ${summary.learned}`);
            }
          }

          if (summary.next_steps) {
            if (useColors) {
              output.push(`${colors.bright}${colors.magenta}Next Steps:${colors.reset} ${summary.next_steps}`);
              output.push('');
            } else {
              output.push(`**Next Steps:** ${summary.next_steps}`);
            }
          }

          // Get files from observations (not from summary which is never populated)
          const sessionFiles = db.getFilesForSession(session.sdk_session_id);

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
        }
      } else if (session.status === 'active') {
        // Active session without summary - show observation titles
        if (useColors) {
          output.push(`${colors.bright}${colors.yellow}⏳ In Progress${colors.reset}`);
          output.push('');
        } else {
          output.push(`**In Progress**`);
          output.push('');
        }

        if (session.user_prompt) {
          if (useColors) {
            output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${session.user_prompt}`);
            output.push('');
          } else {
            output.push(`**Request:** ${session.user_prompt}`);
          }
        }

        const observations = db.getObservationsForSession(session.sdk_session_id);

        if (observations.length > 0) {
          output.push('');
          if (useColors) {
            output.push(`${colors.bright}Observations (${observations.length}):${colors.reset}`);
            for (const obs of observations) {
              output.push(`  ${colors.dim}•${colors.reset} ${obs.title}`);
            }
            output.push('');
          } else {
            output.push(`**Observations (${observations.length}):**`);
            for (const obs of observations) {
              output.push(`- ${obs.title}`);
            }
          }
        } else {
          output.push('');
          if (useColors) {
            output.push(`${colors.dim}No observations yet${colors.reset}`);
            output.push('');
          } else {
            output.push('*No observations yet*');
          }
        }

        output.push('');
        const activeDateTime = new Date(session.started_at).toLocaleString();
        if (useColors) {
          output.push(`${colors.dim}Status: Active - summary pending${colors.reset}`);
          output.push(`${colors.dim}Date: ${activeDateTime}${colors.reset}`);
        } else {
          output.push(`**Status:** Active - summary pending`);
          output.push(`**Date:** ${activeDateTime}`);
        }
      } else {
        // Failed or completed session without summary
        const displayStatus = session.status === 'failed' ? 'stopped' : session.status;
        const statusIcon = session.status === 'failed' ? '⚠️' : '○';

        if (useColors) {
          const statusColor = session.status === 'failed' ? colors.yellow : colors.gray;
          output.push(`${colors.bright}${statusColor}${statusIcon} ${displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)}${colors.reset}`);
          output.push('');
        } else {
          output.push(`**${displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)}**`);
          output.push('');
        }

        if (session.user_prompt) {
          if (useColors) {
            output.push(`${colors.bright}${colors.yellow}Request:${colors.reset} ${session.user_prompt}`);
            output.push('');
          } else {
            output.push(`**Request:** ${session.user_prompt}`);
          }
        }

        output.push('');
        const failedDateTime = new Date(session.started_at).toLocaleString();
        if (useColors) {
          output.push(`${colors.dim}Status: ${displayStatus} - no summary available${colors.reset}`);
          output.push(`${colors.dim}Date: ${failedDateTime}${colors.reset}`);
        } else {
          output.push(`**Status:** ${displayStatus} - no summary available`);
          output.push(`**Date:** ${failedDateTime}`);
        }
      }

      if (!useColors) {
        output.push('');
      }
    }

    if (useColors) {
      output.push('');
      output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
      output.push('');
    }

    return output.join('\n');
  } finally {
    db.close();
  }
}
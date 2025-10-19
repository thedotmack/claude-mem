import path from 'path';
import { SessionStore } from '../services/sqlite/SessionStore.js';

export interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

/**
 * Context Hook - SessionStart
 * Shows user what happened in recent sessions
 *
 * Output: stdout is injected as context to Claude (exit code 0)
 */
export function contextHook(input?: SessionStartInput): void {
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  try {
    const sessions = db.getRecentSessionsWithStatus(project, 3);

    if (sessions.length === 0) {
      // Output directly to stdout for injection into context
      console.log('# Recent Session Context\n\nNo previous sessions found for this project yet.');
      return;
    }

    const output: string[] = [];
    output.push('# Recent Session Context');
    output.push('');
    output.push(`Showing last ${sessions.length} session(s) for **${project}**:`);
    output.push('');

    for (const session of sessions) {
      if (!session.sdk_session_id) continue;

      output.push('---');
      output.push('');

      // Check if session has a summary
      if (session.has_summary) {
        const summary = db.getSummaryForSession(session.sdk_session_id);

        if (summary) {
          const promptLabel = summary.prompt_number ? ` (Prompt #${summary.prompt_number})` : '';
          output.push(`**Summary${promptLabel}**`);
          output.push('');

          if (summary.request) {
            output.push(`**Request:** ${summary.request}`);
          }

          if (summary.completed) {
            output.push(`**Completed:** ${summary.completed}`);
          }

          if (summary.learned) {
            output.push(`**Learned:** ${summary.learned}`);
          }

          if (summary.next_steps) {
            output.push(`**Next Steps:** ${summary.next_steps}`);
          }

          if (summary.files_read) {
            try {
              const files = JSON.parse(summary.files_read);
              if (Array.isArray(files) && files.length > 0) {
                output.push(`**Files Read:** ${files.join(', ')}`);
              }
            } catch {
              if (summary.files_read.trim()) {
                output.push(`**Files Read:** ${summary.files_read}`);
              }
            }
          }

          if (summary.files_edited) {
            try {
              const files = JSON.parse(summary.files_edited);
              if (Array.isArray(files) && files.length > 0) {
                output.push(`**Files Edited:** ${files.join(', ')}`);
              }
            } catch {
              if (summary.files_edited.trim()) {
                output.push(`**Files Edited:** ${summary.files_edited}`);
              }
            }
          }

          output.push(`**Date:** ${summary.created_at.split('T')[0]}`);
        }
      } else if (session.status === 'active') {
        // Active session without summary - show observation titles
        output.push(`**In Progress**`);
        output.push('');

        if (session.user_prompt) {
          output.push(`**Request:** ${session.user_prompt}`);
        }

        const observations = db.getObservationsForSession(session.sdk_session_id);

        if (observations.length > 0) {
          output.push('');
          output.push(`**Observations (${observations.length}):**`);
          for (const obs of observations) {
            output.push(`- ${obs.title}`);
          }
        } else {
          output.push('');
          output.push('*No observations yet*');
        }

        output.push('');
        output.push(`**Status:** Active - summary pending`);
        output.push(`**Date:** ${session.started_at.split('T')[0]}`);
      } else {
        // Failed or completed session without summary
        output.push(`**${session.status.charAt(0).toUpperCase() + session.status.slice(1)}**`);
        output.push('');

        if (session.user_prompt) {
          output.push(`**Request:** ${session.user_prompt}`);
        }

        output.push('');
        output.push(`**Status:** ${session.status} - no summary available`);
        output.push(`**Date:** ${session.started_at.split('T')[0]}`);
      }

      output.push('');
    }

    // Output directly to stdout for injection into context
    console.log(output.join('\n'));
  } finally {
    db.close();
  }
}
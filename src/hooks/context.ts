import path from 'path';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';

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

  const db = new HooksDatabase();

  try {
    const summaries = db.getRecentSummaries(project, 5);

    if (summaries.length === 0) {
      // Output directly to stdout for injection into context
      console.log('# Recent Session Context\n\nNo previous sessions found for this project yet.');
      return;
    }

    const output: string[] = [];
    output.push('# Recent Session Context');
    output.push('');
    const sessionWord = summaries.length === 1 ? 'session' : 'sessions';
    output.push(`Showing last ${summaries.length} ${sessionWord} for **${project}**:`);
    output.push('');

    for (const summary of summaries) {
      output.push('---');
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
      output.push('');
    }

    // Output directly to stdout for injection into context
    console.log(output.join('\n'));
  } finally {
    db.close();
  }
}
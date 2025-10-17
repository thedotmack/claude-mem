import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import path from 'path';

export interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

/**
 * Context Hook - SessionStart
 * Shows user what happened in recent sessions
 */
export function contextHook(input?: SessionStartInput): void {
  if (!input) {
    throw new Error('contextHook requires input');
  }

  const project = input.cwd ? path.basename(input.cwd) : path.basename(path.dirname(input.transcript_path));
  const db = new HooksDatabase();

  try {
    const summaries = db.getRecentSummaries(project, 5);

    if (summaries.length === 0) {
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

    console.log(output.join('\n'));
  } finally {
    db.close();
  }
}

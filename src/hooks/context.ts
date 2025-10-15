import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { PathDiscovery } from '../services/path-discovery.js';
import path from 'path';

export interface SessionStartInput {
  session_id: string;
  cwd: string;
  source?: string;
  [key: string]: any;
}

/**
 * Context Hook - SessionStart
 * Shows user what happened in recent sessions
 */
export function contextHook(input: SessionStartInput): void {
  try {
    // Only run on startup (not on resume)
    if (input.source && input.source !== 'startup') {
      console.log(''); // Output nothing, just exit
      process.exit(0);
    }

    // Extract project from cwd
    const project = path.basename(input.cwd);

    // Get recent summaries
    const db = new HooksDatabase();
    const summaries = db.getRecentSummaries(project, 5);
    db.close();

    // If no summaries, exit silently
    if (summaries.length === 0) {
      console.log(''); // Output nothing
      process.exit(0);
    }

    // Format output for Claude
    const output: string[] = [];
    output.push('# Recent Session Context');
    output.push('');
    output.push(`Here's what happened in recent ${project} sessions:`);
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

      if (summary.files_edited) {
        try {
          const files = JSON.parse(summary.files_edited);
          if (Array.isArray(files) && files.length > 0) {
            output.push(`**Files Edited:** ${files.join(', ')}`);
          }
        } catch {
          // If not valid JSON, show as text
          if (summary.files_edited.trim()) {
            output.push(`**Files Edited:** ${summary.files_edited}`);
          }
        }
      }

      output.push(`**Date:** ${summary.created_at.split('T')[0]}`);
      output.push('');
    }

    // Output to stdout for Claude Code to inject
    console.log(output.join('\n'));
    process.exit(0);

  } catch (error: any) {
    // On error, exit silently - don't block Claude Code
    console.error(`[claude-mem context error: ${error.message}]`);
    process.exit(0);
  }
}

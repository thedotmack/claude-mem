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
  try {
    // Log hook invocation
    console.error('[claude-mem context] Hook fired with input:', JSON.stringify({
      session_id: input?.session_id,
      transcript_path: input?.transcript_path,
      hook_event_name: input?.hook_event_name,
      source: input?.source,
      has_input: !!input
    }));

    // Handle standalone execution (no input provided)
    if (!input) {
      console.error('[claude-mem context] No input provided - exiting (standalone mode)');
      console.log('No input provided - this script is designed to run as a Claude Code SessionStart hook');
      process.exit(0);
    }

    // Extract project from cwd (same as new-hook to ensure consistency)
    // If cwd is not available, fall back to extracting from transcript_path
    const project = input.cwd ? path.basename(input.cwd) : path.basename(path.dirname(input.transcript_path));
    console.error('[claude-mem context] Extracted project name:', project, 'from', input.cwd ? 'cwd' : 'transcript_path');

    // Get recent summaries
    console.error('[claude-mem context] Querying database for recent summaries...');
    const db = new HooksDatabase();
    const summaries = db.getRecentSummaries(project, 5);
    db.close();

    console.error('[claude-mem context] Database query complete - found', summaries.length, 'summaries');

    // Log preview of each summary found
    if (summaries.length > 0) {
      console.error('[claude-mem context] Summary previews:');
      summaries.forEach((summary, idx) => {
        const preview = summary.request?.substring(0, 100) || summary.completed?.substring(0, 100) || '(no content)';
        console.error(`  [${idx + 1}]`, preview + (preview.length >= 100 ? '...' : ''));
      });
    }

    // If no summaries, provide helpful message
    if (summaries.length === 0) {
      console.error('[claude-mem context] No summaries found - outputting empty context message');
      console.log('# Recent Session Context\n\nNo previous sessions found for this project yet.');
      process.exit(0);
    }

    // Format output for Claude
    console.error('[claude-mem context] Building markdown context from summaries...');
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

      // Show files that were read during the session
      if (summary.files_read) {
        try {
          const files = JSON.parse(summary.files_read);
          if (Array.isArray(files) && files.length > 0) {
            output.push(`**Files Read:** ${files.join(', ')}`);
          }
        } catch {
          // Backwards compatibility: if not valid JSON, show as text
          if (summary.files_read.trim()) {
            output.push(`**Files Read:** ${summary.files_read}`);
          }
        }
      }

      // Show files that were edited/written during the session
      if (summary.files_edited) {
        try {
          const files = JSON.parse(summary.files_edited);
          if (Array.isArray(files) && files.length > 0) {
            output.push(`**Files Edited:** ${files.join(', ')}`);
          }
        } catch {
          // Backwards compatibility: if not valid JSON, show as text
          if (summary.files_edited.trim()) {
            output.push(`**Files Edited:** ${summary.files_edited}`);
          }
        }
      }

      output.push(`**Date:** ${summary.created_at.split('T')[0]}`);
      output.push('');
    }

    // Log details about the markdown output
    const markdownOutput = output.join('\n');
    console.error('[claude-mem context] Markdown built successfully');
    console.error('[claude-mem context] Output length:', markdownOutput.length, 'characters,', output.length, 'lines');
    console.error('[claude-mem context] Output preview (first 200 chars):', markdownOutput.substring(0, 200) + '...');
    console.error('[claude-mem context] Outputting context to stdout for Claude Code injection');

    // Output to stdout for Claude Code to inject
    console.log(markdownOutput);

    console.error('[claude-mem context] Context hook completed successfully');
    process.exit(0);

  } catch (error: any) {
    // On error, exit silently - don't block Claude Code
    console.error('[claude-mem context] ERROR occurred during context hook execution');
    console.error('[claude-mem context] Error message:', error.message);
    console.error('[claude-mem context] Error stack:', error.stack);
    console.error('[claude-mem context] Exiting gracefully to avoid blocking Claude Code');
    process.exit(0);
  }
}

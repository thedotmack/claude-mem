/**
 * Cleanup Hook - SessionEnd
 * Consolidated entry point + logic
 * NOW INCLUDES: Summary generation for all completed sessions
 */

import { stdin } from 'process';
import { readFileSync, existsSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { getWorkerPort, ensureWorkerRunning } from '../shared/worker-utils.js';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';
import { logger } from '../utils/logger.js';

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/**
 * Extract last user message from transcript JSONL file
 */
function extractLastUserMessage(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return '';
    }

    const lines = content.split('\n');

    // Parse JSONL and find last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);

        // Claude Code transcript format: {type: "user", message: {role: "user", content: [...]}}
        if (line.type === 'user' && line.message?.content) {
          const content = line.message.content;

          // Extract text content (handle both string and array formats)
          if (typeof content === 'string') {
            return content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            return textParts.join('\n');
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

/**
 * Extract last assistant message from transcript JSONL file
 * Filters out system-reminder tags to avoid polluting summaries
 */
function extractLastAssistantMessage(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return '';
    }

    const lines = content.split('\n');

    // Parse JSONL and find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);

        // Claude Code transcript format: {type: "assistant", message: {role: "assistant", content: [...]}}
        if (line.type === 'assistant' && line.message?.content) {
          let text = '';
          const content = line.message.content;

          // Extract text content (handle both string and array formats)
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            text = textParts.join('\n');
          }

          // Filter out system-reminder tags and their content
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

          // Clean up excessive whitespace
          text = text.replace(/\n{3,}/g, '\n\n').trim();

          return text;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

/**
 * Cleanup Hook Main Logic
 */
async function cleanupHook(input?: SessionEndInput): Promise<void> {
  // Log hook entry point
  console.error('[claude-mem cleanup] Hook fired', {
    input: input ? {
      session_id: input.session_id,
      cwd: input.cwd,
      reason: input.reason
    } : null
  });

  // Handle standalone execution (no input provided)
  if (!input) {
    console.log('No input provided - this script is designed to run as a Claude Code SessionEnd hook');
    console.log('\nExpected input format:');
    console.log(JSON.stringify({
      session_id: "string",
      cwd: "string",
      transcript_path: "string",
      hook_event_name: "SessionEnd",
      reason: "exit"
    }, null, 2));
    process.exit(0);
  }

  const { session_id, reason } = input;
  console.error('[claude-mem cleanup] Searching for active SDK session', { session_id, reason });

  // Find active SDK session
  const db = new SessionStore();
  const session = db.findActiveSDKSession(session_id);

  if (!session) {
    // No active session - nothing to clean up
    console.error('[claude-mem cleanup] No active SDK session found', { session_id });
    db.close();
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }

  console.error('[claude-mem cleanup] Active SDK session found', {
    session_id: session.id,
    sdk_session_id: session.sdk_session_id,
    project: session.project,
    worker_port: session.worker_port
  });

  // Generate summary before marking session as completed
  if (input.transcript_path && input.reason !== 'clear') {
    try {
      await ensureWorkerRunning();

      const promptNumber = db.getPromptCounter(session.id);
      const lastUserMessage = extractLastUserMessage(input.transcript_path);
      const lastAssistantMessage = extractLastAssistantMessage(input.transcript_path);

      console.error('[claude-mem cleanup] Generating summary', {
        sessionDbId: session.id,
        promptNumber,
        hasUserMessage: !!lastUserMessage,
        hasAssistantMessage: !!lastAssistantMessage
      });

      const workerPort = session.worker_port || getWorkerPort();
      const response = await fetch(`http://127.0.0.1:${workerPort}/sessions/${session.id}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt_number: promptNumber,
          last_user_message: lastUserMessage,
          last_assistant_message: lastAssistantMessage
        }),
        signal: AbortSignal.timeout(
          parseInt(process.env.CLAUDE_MEM_SUMMARY_TIMEOUT_MS || '90000', 10)
        )
      });

      if (response.ok) {
        console.error('[claude-mem cleanup] Summary queued successfully');
      } else {
        console.error('[claude-mem cleanup] Summary generation failed (non-critical)', {
          status: response.status
        });
      }
    } catch (error: any) {
      // Summary generation is non-critical - don't block cleanup
      console.error('[claude-mem cleanup] Summary generation error (non-critical):', error.message);
    }
  } else {
    console.error('[claude-mem cleanup] Skipping summary generation', {
      hasTranscript: !!input.transcript_path,
      reason: input.reason
    });
  }

  // Mark session as completed in DB
  db.markSessionCompleted(session.id);
  console.error('[claude-mem cleanup] Session marked as completed in database');

  db.close();

  // Tell worker to stop spinner
  try {
    const workerPort = session.worker_port || happy_path_error__with_fallback('cleanup-hook: session.worker_port is null', { sessionId: session.id }, getWorkerPort());
    await fetch(`http://127.0.0.1:${workerPort}/sessions/${session.id}/complete`, {
      method: 'POST',
      signal: AbortSignal.timeout(1000)
    });
    console.error('[claude-mem cleanup] Worker notified to stop processing indicator');
  } catch (err) {
    // Non-critical - worker might be down
    console.error('[claude-mem cleanup] Failed to notify worker (non-critical):', err);
  }

  console.error('[claude-mem cleanup] Cleanup completed successfully');
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}

// Entry Point
if (stdin.isTTY) {
  // Running manually
  cleanupHook(undefined);
} else {
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    const parsed = input ? JSON.parse(input) : undefined;
    await cleanupHook(parsed);
  });
}

/**
 * Context Hook - SessionStart
 *
 * Pure HTTP client - calls worker to generate context.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import path from 'path';
import { stdin } from 'process';
import { getWorkerPort } from '../shared/worker-utils.js';
import { silentDebug } from '../utils/silent-debug.js';

export interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

/**
 * Fetch context from worker
 */
async function fetchContext(project: string, port: number, useFormatting: boolean): Promise<string> {
  const formatParam = useFormatting ? '&colors=true' : '';
  const response = await fetch(
    `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}${formatParam}`,
    { method: 'GET', signal: AbortSignal.timeout(5000) }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error ${response.status}: ${errorText}`);
  }

  return response.text();
}

/**
 * Context Hook Main Logic - Fire-and-forget HTTP client
 * Returns { unformatted, formatted } for dual output (stderr for user, stdout for model)
 */
async function contextHook(input?: SessionStartInput): Promise<{ unformatted: string; formatted: string }> {
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const port = getWorkerPort();

  silentDebug('[context-hook] Requesting context from worker', {
    project,
    workerPort: port
  });

  try {
    // Fetch both versions in parallel
    const [unformatted, formatted] = await Promise.all([
      fetchContext(project, port, false),
      fetchContext(project, port, true)
    ]);

    silentDebug('[context-hook] Context received', { unformattedLength: unformatted.length, formattedLength: formatted.length });
    return { unformatted, formatted };
  } catch (error: any) {
    // Worker might not be running
    silentDebug('[context-hook] Worker not reachable', { error: error.message });
    const fallback = `# [${project}] recent context\n\nWorker not available. Start with: pm2 start claude-mem-worker`;
    return { unformatted: fallback, formatted: fallback };
  }
}

// Export for use by worker service (compatibility)
export { contextHook };

// Entry Point - handle stdin/stdout
if (stdin.isTTY) {
  // Running manually from terminal - show formatted output
  contextHook(undefined).then(({ formatted }) => {
    console.log(formatted);
    process.exit(0);
  });
} else {
  // Running from hook - formatted to stderr (user display), unformatted to stdout (model context)
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    const { unformatted, formatted } = await contextHook(parsed);

    // Write formatted version to stderr for user display
    process.stderr.write(formatted + '\n');

    // Write unformatted version to stdout as JSON for model context
    const result = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: unformatted
      }
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  });
}
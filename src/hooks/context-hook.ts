/**
 * Context Hook - SessionStart
 *
 * Pure HTTP client - calls worker to generate context.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import path from "path";
import { stdin } from "process";
import { readFileSync, existsSync } from "fs";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";
import { HOOK_TIMEOUTS } from "../shared/hook-constants.js";
import { handleWorkerError } from "../shared/hook-error-handler.js";
import { handleFetchError } from "./shared/error-handler.js";

export interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
}

/**
 * Check if the first user message contains <fresh-session> tag
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns true if <fresh-session> tag is found in first user message
 */
function checkForFreshSessionTag(transcriptPath: string): boolean {
  try {
    if (!existsSync(transcriptPath)) {
      return false;
    }

    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return false;
    }

    const lines = content.split('\n');

    // Look for the first user message
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Check if this is a user message
        if (entry.type === 'user' && entry.message?.content) {
          const contentBlocks = Array.isArray(entry.message.content)
            ? entry.message.content
            : [entry.message.content];

          // Check all content blocks for the tag
          for (const block of contentBlocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
              if (block.text.includes('<fresh-session>')) {
                return true;
              }
            }
          }

          // Found first user message, no tag present
          return false;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    return false;
  } catch (error) {
    // If we can't read the transcript, proceed with normal context injection
    return false;
  }
}

async function contextHook(input?: SessionStartInput): Promise<string> {
  // Check for fresh-session tag before any processing
  if (input?.transcript_path) {
    const isFreshSession = checkForFreshSessionTag(input.transcript_path);
    if (isFreshSession) {
      // User requested fresh session - skip context injection
      return '';
    }
  }

  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : "unknown-project";
  const port = getWorkerPort();

  const url = `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT) });

    if (!response.ok) {
      const errorText = await response.text();
      handleFetchError(response, errorText, {
        hookName: 'context',
        operation: 'Context generation',
        project,
        port
      });
    }

    const result = await response.text();
    return result.trim();
  } catch (error: any) {
    handleWorkerError(error);
  }
}

// Entry Point - handle stdin/stdout
const forceColors = process.argv.includes("--colors");

if (stdin.isTTY || forceColors) {
  contextHook(undefined).then((text) => {
    console.log(text);
    process.exit(0);
  });
} else {
  let input = "";
  stdin.on("data", (chunk) => (input += chunk));
  stdin.on("end", async () => {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    const text = await contextHook(parsed);

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      })
    );
    process.exit(0);
  });
}

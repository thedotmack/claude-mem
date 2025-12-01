/**
 * Context Hook - SessionStart
 * Thin orchestrator that delegates to worker service
 */

import path from 'path';
import { existsSync, unlinkSync } from 'fs';
import { stdin } from 'process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Version marker path (same as smart-install.js)
const VERSION_MARKER_PATH = path.join(__dirname, '../../.install-version');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
};

export interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

/**
 * Get worker port from environment or default
 */
function getWorkerPort(): number {
  return parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
}

/**
 * Context Hook Main Logic
 */
async function contextHook(input?: SessionStartInput, useColors: boolean = false): Promise<string> {
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  try {
    const workerPort = getWorkerPort();
    const params = new URLSearchParams({
      project,
      useColors: String(useColors),
      cwd
    });

    const response = await fetch(
      `http://localhost:${workerPort}/api/context/session-start?${params}`
    );

    if (!response.ok) {
      throw new Error(`Worker returned ${response.status}`);
    }

    const result = await response.json();
    return result[0]?.text || '';
  } catch (error: any) {
    // Check for native module ABI mismatch
    if (error.code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        // Marker might not exist, that's okay
      }
      console.error('⚠️  Native module rebuild needed - restart Claude Code to auto-fix');
      console.error('   (This happens after Node.js version upgrades)');
      process.exit(0);
    }

    // Graceful degradation for other errors
    console.error('[context-hook] Worker unavailable:', error.message);
    return useColors
      ? `${colors.red}⚠️  Context unavailable (worker offline)${colors.reset}`
      : '⚠️  Context unavailable (worker offline)';
  }
}

// Entry Point - handle stdin/stdout
const forceColors = process.argv.includes('--colors');

if (stdin.isTTY || forceColors) {
  // Running manually from terminal - print formatted output with colors
  contextHook(undefined, true).then(contextOutput => {
    console.log(contextOutput);
    process.exit(0);
  });
} else {
  // Running from hook - wrap in hookSpecificOutput JSON format
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    const contextOutput = await contextHook(parsed, false);
    const result = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextOutput
      }
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  });
}

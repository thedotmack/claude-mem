
/**
 * Context Hook Entry Point - SessionStart
 * Standalone executable for plugin hooks
 */

import { contextHook } from '../../hooks/context.js';
import { stdin } from 'process';

try {
  // Check for --index flag
  const useIndexView = process.argv.includes('--index');

  if (stdin.isTTY) {
    // Running manually from terminal - print formatted output with colors
    const contextOutput = contextHook(undefined, true, useIndexView);
    console.log(contextOutput);
    process.exit(0);
  } else {
    // Running from hook - wrap in JSON format without colors
    let input = '';
    stdin.on('data', (chunk) => input += chunk);
    stdin.on('end', () => {
      const parsed = input.trim() ? JSON.parse(input) : undefined;
      const contextOutput = contextHook(parsed, false, useIndexView);
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
} catch (error: any) {
  console.error(`[claude-mem context-hook error: ${error.message}]`);
  process.exit(0);
}

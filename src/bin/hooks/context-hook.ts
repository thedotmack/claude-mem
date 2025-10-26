
/**
 * Context Hook Entry Point - SessionStart
 * Standalone executable for plugin hooks
 */

import { contextHook } from '../../hooks/context.js';
import { stdin } from 'process';

// Check for --index flag
const useIndexView = process.argv.includes('--index');

if (stdin.isTTY) {
  // Running manually from terminal - print formatted output with colors
  try {
    const contextOutput = contextHook(undefined, true, useIndexView);
    console.log(contextOutput);
    process.exit(0);
  } catch (error: any) {
    console.error(`[claude-mem context-hook error: ${error.message}]`);
    console.error(error.stack);
    process.exit(1);
  }
} else {
  // Running from hook - wrap in hookSpecificOutput JSON format
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', () => {
    try {
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
    } catch (error: any) {
      // Output error in JSON format so hook doesn't fail
      const errorResult = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `[claude-mem ERROR: ${error.message}]\nInput: ${input.substring(0, 200)}...\n${error.stack}`
        }
      };
      console.log(JSON.stringify(errorResult));
      process.exit(1);
    }
  });
}


/**
 * Context Hook Entry Point - SessionStart
 * Standalone executable for plugin hooks
 */

// Bootstrap: Ensure dependencies are installed before importing modules
import { ensureDependencies } from '../../shared/bootstrap.js';
import { stdin } from 'process';

// Run bootstrap synchronously BEFORE any dynamic imports
ensureDependencies();

// Dynamic import AFTER bootstrap ensures dependencies are installed
const { contextHook } = await import('../../hooks/context.js');

try {
  if (stdin.isTTY) {
    const contextOutput = contextHook();
    const result = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextOutput
      }
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  } else {
    let input = '';
    stdin.on('data', (chunk) => input += chunk);
    stdin.on('end', () => {
      const parsed = input.trim() ? JSON.parse(input) : undefined;
      const contextOutput = contextHook(parsed);
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

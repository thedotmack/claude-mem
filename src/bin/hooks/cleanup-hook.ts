
/**
 * Cleanup Hook Entry Point - SessionEnd
 * Standalone executable for plugin hooks
 */

// Bootstrap: Ensure dependencies are installed before importing modules
import { ensureDependencies } from '../../shared/bootstrap.js';
import { stdin } from 'process';

// Run bootstrap synchronously BEFORE any dynamic imports
ensureDependencies();

// Dynamic import AFTER bootstrap ensures dependencies are installed
const { cleanupHook } = await import('../../hooks/cleanup.js');

// Read input from stdin
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    await cleanupHook(parsed);
  } catch (error: any) {
    console.error(`[claude-mem cleanup-hook error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
});

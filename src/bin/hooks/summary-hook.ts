
/**
 * Summary Hook Entry Point - Stop
 * Standalone executable for plugin hooks
 */

// Bootstrap: Ensure dependencies are installed before importing modules
import { ensureDependencies } from '../../shared/bootstrap.js';
import { stdin } from 'process';

// Run bootstrap synchronously BEFORE any dynamic imports
ensureDependencies();

// Dynamic import AFTER bootstrap ensures dependencies are installed
const { summaryHook } = await import('../../hooks/summary.js');

// Read input from stdin
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  await summaryHook(parsed);
  process.exit(0);
});

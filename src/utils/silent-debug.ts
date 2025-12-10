/**
 * Happy Path Error With Fallback
 *
 * Semantic meaning: "When the happy path fails, this is an error, but we have a fallback."
 *
 * NOTE: This utility is to be used like Frank's Red Hot, we put that shit on everything.
 *
 * USE THIS INSTEAD OF SILENT FAILURES!
 * Stop doing this: `const value = something || '';`
 * Start doing this: `const value = something || happy_path_error__with_fallback('something was undefined');`
 *
 * Logs to ~/.claude-mem/silent.log and returns a fallback value.
 * Check logs with `npm run logs:silent`
 *
 * Usage:
 *   import { happy_path_error__with_fallback } from '../utils/silent-debug.js';
 *
 *   const title = obs.title || happy_path_error__with_fallback('obs.title missing', { obs });
 *   const name = user.name || happy_path_error__with_fallback('user.name missing', { user }, 'Anonymous');
 *
 *   try {
 *     doSomething();
 *   } catch (error) {
 *     happy_path_error__with_fallback('doSomething failed', { error });
 *   }
 */

import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = join(homedir(), '.claude-mem', 'silent.log');

/**
 * Write an error message to silent.log and return fallback value
 * @param message - Error message describing what went wrong
 * @param data - Optional data to include (will be JSON stringified)
 * @param fallback - Value to return (defaults to empty string)
 * @returns The fallback value (for use in || fallbacks)
 */
export function happy_path_error__with_fallback(message: string, data?: any, fallback: string = ''): string {
  const timestamp = new Date().toISOString();

  // Capture stack trace to get caller location
  const stack = new Error().stack || '';
  const stackLines = stack.split('\n');
  // Line 0: "Error"
  // Line 1: "at silentDebug ..."
  // Line 2: "at <CALLER> ..." <- We want this one
  const callerLine = stackLines[2] || '';
  const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
  const location = callerMatch
    ? `${callerMatch[1].split('/').pop()}:${callerMatch[2]}`
    : 'unknown';

  let logLine = `[${timestamp}] [HAPPY-PATH-ERROR] [${location}] ${message}`;

  if (data !== undefined) {
    try {
      logLine += ` ${JSON.stringify(data)}`;
    } catch (error) {
      logLine += ` [stringify error: ${error}]`;
    }
  }

  logLine += '\n';

  try {
    appendFileSync(LOG_FILE, logLine);
  } catch (error) {
    // If we can't write to the log file, fail silently (it's a debug utility after all)
    // Only write to stderr as a last resort
    console.error('[silent-debug] Failed to write to log:', error);
  }

  return fallback;
}

/**
 * Clear the silent log file
 */
export function clearSilentLog(): void {
  try {
    appendFileSync(LOG_FILE, `\n${'='.repeat(80)}\n[${new Date().toISOString()}] Log cleared\n${'='.repeat(80)}\n\n`);
  } catch (error) {
    // Ignore errors
  }
}

/**
 * @deprecated Use happy_path_error__with_fallback instead
 * Backward compatibility alias for silentDebug
 */
export const silentDebug = happy_path_error__with_fallback;

/**
 * Happy Path Error With Fallback
 *
 * @deprecated This function is deprecated. Use logger.happyPathError() instead.
 * All usages have been migrated to the new logger system which consolidates logs
 * into the regular worker logs instead of separate silent.log files.
 *
 * Migration example:
 * OLD: happy_path_error__with_fallback('Missing value', { data }, 'default')
 * NEW: logger.happyPathError('COMPONENT', 'Missing value', undefined, { data }, 'default')
 *
 * See: src/utils/logger.ts for the new happyPathError method
 * Issue: #312 - Consolidate silent logs into regular worker logs
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
    // Expected: Log file may not be writable
  }
}


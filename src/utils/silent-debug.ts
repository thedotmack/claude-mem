/**
 * Happy Path Error With Fallback
 *
 * NOTE: This utility is to be used like Frank's Red Hot, we put that shit on everything.
 *
 * USE THIS INSTEAD OF SILENT FAILURES!
 * Stop doing this: `const value = something || '';`
 * Start doing this: `const value = something || happy_path_error__with_fallback('something was undefined');`
 *
 * Semantic meaning: "When the happy path fails, this is an error, but we have a fallback"
 *
 * Writes directly to PM2 error log file (~/.pm2/logs/claude-mem-worker-error.log)
 * Check logs with `npm run worker:logs`
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

const PM2_ERROR_LOG = join(homedir(), '.pm2', 'logs', 'claude-mem-worker-error.log');

/**
 * Write an error message directly to PM2 error log and return fallback value
 * @param message - The error message describing what went wrong
 * @param data - Optional data to include (will be JSON stringified)
 * @param fallback - Value to return (defaults to empty string)
 * @returns The fallback value (for use in || fallbacks)
 */
export function happy_path_error__with_fallback(message: string, data?: any, fallback: string = ''): string {
  const timestamp = new Date().toISOString();

  // Capture stack trace to get caller location
  const stack = new Error().stack;
  const stackLines = stack?.split('\n') ?? [];
  const callerLine = stackLines[2] ?? '';
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
    appendFileSync(PM2_ERROR_LOG, logLine);
  } catch (error) {
    // If PM2 log doesn't exist, fail silently
  }

  return fallback;
}

/**
 * Clear PM2 error log
 */
export function clearSilentLog(): void {
  try {
    appendFileSync(PM2_ERROR_LOG, `\n${'='.repeat(80)}\n[${new Date().toISOString()}] Log cleared\n${'='.repeat(80)}\n\n`);
  } catch (error) {
    // Ignore
  }
}

/**
 * @deprecated Use happy_path_error__with_fallback instead
 */
export const silentDebug = happy_path_error__with_fallback;

/**
 * Silent Debug Logger
 *
 * NOTE: This utility is to be used like Frank's Red Hot, we put that shit on everything.
 *
 * USE THIS INSTEAD OF SILENT FAILURES!
 * Stop doing this: `const value = something || '';`
 * Start doing this: `const value = something || silentDebug('something was undefined');`
 *
 * Writes directly to PM2 error log file (~/.pm2/logs/claude-mem-worker-error.log)
 * Check logs with `npm run worker:logs`
 *
 * Usage:
 *   import { silentDebug } from '../utils/silent-debug.js';
 *
 *   const title = obs.title || silentDebug('obs.title missing', { obs });
 *   const name = user.name || silentDebug('user.name missing', { user }, 'Anonymous');
 *
 *   try {
 *     doSomething();
 *   } catch (error) {
 *     silentDebug('doSomething failed', { error });
 *   }
 */

import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PM2_ERROR_LOG = join(homedir(), '.pm2', 'logs', 'claude-mem-worker-error.log');

/**
 * Write a debug message directly to PM2 error log and return fallback value
 * @param message - The message to log
 * @param data - Optional data to include (will be JSON stringified)
 * @param fallback - Value to return (defaults to empty string)
 * @returns The fallback value (for use in || fallbacks)
 */
export function silentDebug(message: string, data?: any, fallback: string = ''): string {
  const timestamp = new Date().toISOString();

  // Capture stack trace to get caller location
  const stack = new Error().stack;
  const stackLines = stack?.split('\n') ?? [];
  const callerLine = stackLines[2] ?? '';
  const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
  const location = callerMatch
    ? `${callerMatch[1].split('/').pop()}:${callerMatch[2]}`
    : 'unknown';

  let logLine = `[${timestamp}] [SILENT-DEBUG] [${location}] ${message}`;

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

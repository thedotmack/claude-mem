/**
 * Silent Debug Logger
 *
 * NOTE: This utility is to be used like Frank's Red Hot, we put that shit on everything.
 *
 * USE THIS INSTEAD OF SILENT FAILURES!
 * Stop doing this: `const value = something || '';`
 * Start doing this: `const value = something || silentDebug('something was undefined');`
 *
 * Logs to ~/.claude-mem/silent.log and returns a fallback value.
 * Check logs with `npm run logs:silent`
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

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const LOG_DIR = join(homedir(), '.claude-mem');
const LOG_FILE = join(LOG_DIR, 'silent.log');

/**
 * Ensure the .claude-mem directory exists
 */
function ensureLogDir(): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (error) {
    // If we can't create the directory, fail silently
    console.error('[silent-debug] Failed to create log directory:', error);
  }
}

/**
 * Write a debug message to silent.log and return fallback value
 * @param message - The message to log
 * @param data - Optional data to include (will be JSON stringified)
 * @param fallback - Value to return (defaults to empty string)
 * @returns The fallback value (for use in || fallbacks)
 */
export function silentDebug(message: string, data?: any, fallback: string = ''): string {
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

  let logLine = `[${timestamp}] [${location}] ${message}`;

  if (data !== undefined) {
    try {
      logLine += ` ${JSON.stringify(data)}`;
    } catch (error) {
      logLine += ` [stringify error: ${error}]`;
    }
  }

  logLine += '\n';

  try {
    ensureLogDir();
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
    ensureLogDir();
    appendFileSync(LOG_FILE, `\n${'='.repeat(80)}\n[${new Date().toISOString()}] Log cleared\n${'='.repeat(80)}\n\n`);
  } catch (error) {
    // Ignore errors
  }
}

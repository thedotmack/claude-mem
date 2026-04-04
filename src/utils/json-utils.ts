/**
 * Shared JSON file utilities for claude-mem.
 *
 * Provides safe read/write helpers used across the CLI and services.
 */

import { existsSync, readFileSync } from 'fs';
import { logger } from './logger.js';

/**
 * Read a JSON file safely, returning a default value if the file
 * does not exist or contains corrupt JSON.
 *
 * @param filePath - Absolute path to the JSON file.
 * @param defaultValue - Value returned when the file is missing or unreadable.
 * @returns The parsed JSON content, or `defaultValue` on failure.
 */
export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger.error('JSON', `Corrupt JSON file, using default`, { path: filePath }, error as Error);
    return defaultValue;
  }
}

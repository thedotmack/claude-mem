
import { existsSync, readFileSync } from 'fs';
import { logger } from './logger.js';

export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error: unknown) {
    throw new Error(`Corrupt JSON file, refusing to overwrite: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

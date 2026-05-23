
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

export function parseJsonArrayColumn(
  value: unknown,
  onParseError?: (error: unknown, rawValue: string) => void,
): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch (error) {
    onParseError?.(error, value);
    return [];
  }
}


import { existsSync, readFileSync } from 'fs';

/**
 * Strip a leading UTF-8 BOM (U+FEFF) from a string.
 *
 * Windows tooling — PowerShell 5.1, some editors and formatters — prepends a
 * BOM (EF BB BF) when it rewrites a file. Node/Bun decode it to U+FEFF at
 * position 0 on `utf-8` read, and JSON.parse rejects it as an unexpected token.
 * Our own writes never add a BOM, so any BOM on disk came from external
 * tooling; readers must tolerate it. See issue #3013.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(stripBom(readFileSync(filePath, 'utf-8')));
  } catch (error: unknown) {
    throw new Error(`Corrupt JSON file, refusing to overwrite: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

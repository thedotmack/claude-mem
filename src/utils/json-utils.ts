import { existsSync, readFileSync } from 'fs';
import { parseJsonWithBom } from '../shared/atomic-json.js';

export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    // Windows tooling (PowerShell 5.1, some editors) may rewrite JSON with a
    // UTF-8 BOM. Node/Bun decode that to U+FEFF at offset 0, which JSON.parse
    // rejects. Strip on read so install/uninstall and other callers survive.
    // See #3013.
    return parseJsonWithBom<T>(readFileSync(filePath, 'utf-8'));
  } catch (error: unknown) {
    throw new Error(`Corrupt JSON file, refusing to overwrite: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

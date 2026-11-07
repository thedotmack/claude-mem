import { existsSync, readFileSync } from 'fs';
import { readJsonFileWithBom } from '../../shared/atomic-json.js';
import { settingsTarget } from '../../shared/settings-document.js';

/**
 * Read a claude-mem settings.json as a flat key/value record, unwrapping the
 * legacy `env`-nested shape. Returns null when the file is missing or not a
 * JSON object; throws on invalid JSON so callers choose their own recovery.
 */
export function readFlatSettings(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = readJsonFileWithBom<unknown>(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return settingsTarget(record);
}

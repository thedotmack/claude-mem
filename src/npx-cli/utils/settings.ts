import { existsSync, readFileSync } from 'fs';
import { parseJsonWithBom } from '../../shared/atomic-json.js';

/**
 * Read a claude-mem settings.json as a flat key/value record, unwrapping the
 * legacy `env`-nested shape. Returns null when the file is missing or not a
 * JSON object; throws on invalid JSON so callers choose their own recovery.
 */
export function readFlatSettings(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = parseJsonWithBom(readFileSync(path, 'utf-8'));
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  return (record.env && typeof record.env === 'object' ? record.env : record) as Record<string, unknown>;
}

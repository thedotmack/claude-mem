import { logger } from '../utils/logger.js';

export interface NumberBounds {
  min: number;
  max: number;
  integer: boolean;
}

/**
 * settings.json may hold a JSON number where a string is declared, so a raw
 * value is a string, a number, or unset. Anything else counts as unset.
 */
export type RawSetting = string | number | null | undefined;

function rawText(raw: unknown): string {
  if (typeof raw === 'number') return String(raw);
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Strictly parses a numeric setting: the whole string must be a finite number
 * inside [min, max] (and a whole number when `integer`). Anything else is null.
 */
export function parseBoundedNumber(raw: RawSetting, bounds: NumberBounds): number | null {
  const text = rawText(raw);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) return null;
  if (bounds.integer && !Number.isInteger(parsed)) return null;
  return parsed;
}

/**
 * Reads a bounded numeric setting. An unset/empty value yields the default
 * silently; an invalid one yields the default and a single warning that
 * names the key.
 */
export function resolveBoundedNumber(
  component: 'CHROMA_MCP' | 'CHROMA_SYNC',
  key: string,
  raw: RawSetting,
  bounds: NumberBounds,
  defaultValue: number,
): number {
  const parsed = parseBoundedNumber(raw, bounds);
  if (parsed !== null) return parsed;
  if (rawText(raw) !== '') {
    logger.warn(component, `Invalid ${key}, using default`, {
      value: raw,
      min: bounds.min,
      max: bounds.max,
      default: defaultValue,
    });
  }
  return defaultValue;
}

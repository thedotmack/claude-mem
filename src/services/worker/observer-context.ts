import { logger } from '../../utils/logger.js';
import type { ConversationMessage } from '../worker-types.js';

export const OBSERVER_CONTEXT_MAX_STRING_CHARS = 4000;
export const OBSERVER_CONTEXT_MAX_SERIALIZED_CHARS = 16000;
export const OBSERVER_CONTEXT_MAX_ARRAY_ITEMS = 20;
export const OBSERVER_CONTEXT_MAX_OBJECT_KEYS = 80;
export const OBSERVER_CONTEXT_MAX_HISTORY_MESSAGES = 12;

const BINARY_KEY_RE = /(?:base64|data_?url|image|screenshot|binary|blob|bytes|audio|video)/i;
const DATA_URL_RE = /data:(?:image|audio|video|application\/octet-stream)\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]{128,}/gi;
const BASE64ISH_RE = /^[a-z0-9+/=_-\s]+$/i;

function placeholder(kind: string, length: number): string {
  return `[stripped ${kind}: ${length} chars]`;
}

function looksLikeBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 512) return false;
  if (!BASE64ISH_RE.test(compact)) return false;
  const padding = compact.endsWith('==') || compact.endsWith('=');
  const base64Signal = /[+/=_-]/.test(compact);
  return padding || (base64Signal && compact.length % 4 === 0);
}

export function sanitizeObserverText(
  text: string,
  options: { key?: string; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? OBSERVER_CONTEXT_MAX_STRING_CHARS;
  const key = options.key ?? '';

  let sanitized = text.replace(DATA_URL_RE, match => placeholder('data URL', match.length));
  const trimmed = sanitized.trim();

  if (BINARY_KEY_RE.test(key) && sanitized.length > 80) {
    sanitized = placeholder(`${key} payload`, sanitized.length);
  } else if (/^data:/i.test(trimmed) && sanitized.length > 128) {
    sanitized = placeholder('data URL', sanitized.length);
  } else if (looksLikeBase64(trimmed)) {
    sanitized = placeholder('base64 payload', sanitized.length);
  }

  if (sanitized.length > maxChars) {
    return `${sanitized.slice(0, maxChars)}\n[truncated ${sanitized.length - maxChars} chars]`;
  }

  return sanitized;
}

function sanitizeValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return sanitizeObserverText(value, { key });
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, OBSERVER_CONTEXT_MAX_ARRAY_ITEMS)
      .map(item => sanitizeValue(item, key, seen));
    if (value.length > OBSERVER_CONTEXT_MAX_ARRAY_ITEMS) {
      kept.push(`[truncated array: ${value.length - OBSERVER_CONTEXT_MAX_ARRAY_ITEMS} additional items]`);
    }
    return kept;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [entryKey, entryValue] of entries.slice(0, OBSERVER_CONTEXT_MAX_OBJECT_KEYS)) {
    output[entryKey] = sanitizeValue(entryValue, entryKey, seen);
  }
  if (entries.length > OBSERVER_CONTEXT_MAX_OBJECT_KEYS) {
    output.__truncated_keys = entries.length - OBSERVER_CONTEXT_MAX_OBJECT_KEYS;
  }
  return output;
}

export function stringifyObserverPayload(value: unknown, label: string): string {
  const rawLength = (() => {
    try {
      return JSON.stringify(value)?.length ?? 0;
    } catch {
      return 0;
    }
  })();

  const sanitized = sanitizeValue(value, undefined, new WeakSet<object>());
  const serialized = JSON.stringify(sanitized) ?? 'null';
  const bounded = sanitizeObserverText(serialized, {
    key: label,
    maxChars: OBSERVER_CONTEXT_MAX_SERIALIZED_CHARS,
  });

  if (rawLength > 0 && bounded.length < rawLength) {
    logger.debug('SDK', 'Observer payload sanitized before provider prompt', {
      label,
      originalChars: rawLength,
      boundedChars: bounded.length,
    });
  }

  return bounded;
}

export function boundObserverHistory(history: ConversationMessage[]): ConversationMessage[] {
  if (history.length <= OBSERVER_CONTEXT_MAX_HISTORY_MESSAGES) {
    return history;
  }

  const first = history[0];
  const newest = history.slice(-(OBSERVER_CONTEXT_MAX_HISTORY_MESSAGES - 1));
  return [first, ...newest];
}

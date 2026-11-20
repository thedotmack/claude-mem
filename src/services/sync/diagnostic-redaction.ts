import { getRedactionConfig, redactJsonStrings, redactSensitive, type RedactionConfig } from '../../utils/redaction.js';

const MAX_DIAGNOSTIC_CHARS = 1024 * 1024;
const BUDGET_MARKER = "<redacted type='diagnostic_budget'/>";

/** Rejected input is untrusted at every level, including JSON encoded inside JSON strings. */
export function redactSyncDiagnostic<T>(value: T, config: RedactionConfig = getRedactionConfig()): T {
  if (!config.enabled) return value;
  let remainingNodes = 50_000;
  const text = (input: string, keys: readonly string[] = []): string => {
    if (!keys.length) return redactSensitive(input, config).redacted;
    for (const key of keys) {
      const redacted = redactJsonStrings({ [key]: input }, config)[key];
      if (redacted !== input) return redacted;
    }
    return input;
  };
  const walk = (input: unknown, depth: number, keys: readonly string[] = []): unknown => {
    if (depth > 32 || --remainingNodes < 0) return BUDGET_MARKER;
    if (typeof input === 'string') {
      if (input.length > MAX_DIAGNOSTIC_CHARS) return redactSensitive(input, config).redacted;
      // Preserve unchanged bytes for safe retryable bodies. Parsing nested
      // body/fields strings first also lets keyed secret rules inspect them.
      try {
        const parsed: unknown = JSON.parse(input);
        if (parsed !== null && (typeof parsed === 'object' || typeof parsed === 'string')) {
          // Encoding and wrapper objects do not remove a credential field's
          // meaning. Keep its ancestor keys alongside each nested field name.
          const sanitized = walk(parsed, depth + 1, keys);
          const serialized = JSON.stringify(sanitized);
          if (serialized !== JSON.stringify(parsed)) return serialized;
        }
      } catch { /* Malformed input is still redacted as plain diagnostic text. */ }
      return text(input, keys);
    }
    if (Array.isArray(input)) return input.length > remainingNodes ? BUDGET_MARKER : input.map(item => walk(item, depth + 1, keys));
    if (input && typeof input === 'object') {
      const entries = Object.entries(input);
      if (entries.length > remainingNodes) return BUDGET_MARKER;
      return Object.fromEntries(entries.map(([name, item]) => [text(name, keys), walk(item, depth + 1, [name, ...keys])]));
    }
    return input;
  };
  return walk(value, 0) as T;
}

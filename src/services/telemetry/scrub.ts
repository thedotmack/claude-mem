/**
 * Whitelist scrubber for telemetry event properties.
 *
 * Only these keys may ever leave the machine. Everything else — paths,
 * project names, prompts, queries, emails, IPs, env values — is dropped
 * silently, regardless of what a call site passes in.
 */
export const ALLOWED_PROPERTY_KEYS: Set<string> = new Set([
  'version',
  'os',
  'arch',
  'runtime',
  'runtime_version',
  'duration_ms',
  'outcome',
  'error_category',
  'locale',
  'is_ci',
]);

const MAX_STRING_LENGTH = 200;

/**
 * Filters properties down to whitelisted keys with primitive values only.
 * Strings are truncated to 200 chars. Objects, arrays, functions, null,
 * undefined, and non-finite numbers are dropped. Pure, never throws.
 */
export function scrubProperties(
  props: Record<string, unknown>
): Record<string, string | number | boolean> {
  const scrubbed: Record<string, string | number | boolean> = {};
  try {
    if (!props || typeof props !== 'object') return scrubbed;
    for (const key of Object.keys(props)) {
      if (!ALLOWED_PROPERTY_KEYS.has(key)) continue;
      const value = props[key];
      if (typeof value === 'string') {
        scrubbed[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        scrubbed[key] = value;
      } else if (typeof value === 'boolean') {
        scrubbed[key] = value;
      }
      // Everything else (objects, arrays, functions, null, undefined,
      // NaN/Infinity, symbols, bigints) is dropped silently.
    }
  } catch {
    // Never throw from the scrubber — worst case we send fewer properties
  }
  return scrubbed;
}

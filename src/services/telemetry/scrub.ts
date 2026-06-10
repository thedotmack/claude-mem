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
  // Bounded enums/counters only — never user content. endpoint is one of OUR
  // route names, ide/provider/runtime_mode are installer enums, trigger is
  // start|heartbeat, count/has_summary/is_update are volume/shape metrics.
  'endpoint',
  'ide',
  'provider',
  'runtime_mode',
  'trigger',
  'count',
  'has_summary',
  'is_update',
  // context_injected depth/economics — integers, booleans, and our own enums.
  'observation_count',
  'session_count',
  'timeline_depth_days',
  'has_session_summary',
  'obs_type_bugfix',
  'obs_type_discovery',
  'obs_type_decision',
  'obs_type_refactor',
  'obs_type_other',
  'tokens_injected',
  'tokens_saved_vs_naive',
  'mode',
  'search_strategy',
  // session_compressed depth — model id, our trigger names, real token usage.
  'observation_type',
  'hook',
  'compression_ms',
  'tokens_input',
  'tokens_output',
  'compression_ratio',
  'model',
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

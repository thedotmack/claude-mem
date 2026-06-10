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
  // os_version is the kernel release string (e.g. "10.0.22631"), is_wsl a
  // boolean — platform facts for diagnosing install→worker funnel dropoff.
  'os_version',
  'is_wsl',
  'arch',
  'runtime',
  'runtime_version',
  'node_version',
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
  // Install funnel shape — install_method is a package-manager enum parsed
  // from npm_config_user_agent, the *_version keys are tool version strings.
  'install_method',
  'interactive',
  'bun_version',
  'uv_version',
  'claude_code_version',
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
  // Provider-reported spend of one compression call in USD (SDK result message
  // for Claude, usage.cost for OpenRouter) — never an estimate.
  'cost_usd',
  // 'openrouter' | 'custom' — whether the OpenRouter provider talks to
  // openrouter.ai or a user-pointed OpenAI-compatible gateway.
  'endpoint_class',
  // worker_started install snapshot — aggregate shape of the local memory DB:
  // row counts, file size in MB, and day-granularity age/recency. Counts and
  // day deltas only — never project names, observation text, or content.
  'db_observation_count',
  'db_session_count',
  'db_summary_count',
  'db_project_count',
  'db_size_mb',
  'install_age_days',
  'obs_count_7d',
  'obs_count_30d',
  'days_since_last_obs',
  // search_performed retrieval quality — result_count is an integer,
  // chroma_available a boolean, fallback_reason one of OUR enum values
  // (none | chroma_connection | chroma_error | chroma_not_initialized).
  // Never the query, never an error message.
  'result_count',
  'chroma_available',
  'fallback_reason',
  // session_compressed trust signals — booleans, counters, and our own
  // closed enums (invalid_output_class: xml | idle | prose | poisoned, where
  // 'xml' means XML-shaped output that still failed to parse; abort_reason:
  // idle | shutdown | overflow | restart_guard | quota | poisoned | none).
  // Never model output, never raw abort strings.
  'fabrication_detected',
  'fabricated_count',
  'invalid_output_class',
  'consecutive_invalid_outputs',
  'respawn_triggered',
  'abort_reason',
  // Worker lifecycle health — previous_shutdown (crash | clean | unknown),
  // shutdown_reason (stop | restart | signal), uptime in whole seconds, and
  // process memory as integer megabytes. No paths, no PIDs.
  'previous_shutdown',
  'previous_uptime_seconds',
  'uptime_seconds',
  'shutdown_reason',
  'process_rss_mb',
  'heap_used_mb',
  // hook_failed distress signal — hook_type is one of OUR hook names
  // (context | session-init | observation | summarize | file-context),
  // error_mode (worker_unavailable | blocking_error), plus a consecutive
  // failure counter and threshold flag. Never an error message.
  'hook_type',
  'error_mode',
  'consecutive_failures',
  'threshold_tripped',
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

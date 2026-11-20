import { describe, it, expect } from 'bun:test';
import { scrubProperties, ALLOWED_PROPERTY_KEYS } from '../../src/services/telemetry/scrub';

describe('scrubProperties', () => {
  it('keeps primitive values, versions and model ids', () => {
    const props = { version: '13.4.2', model: 'claude-haiku-4-5', duration_ms: 1234, is_ci: false };
    expect(scrubProperties(props)).toEqual(props);
  });

  it('allows the event property keys', () => {
    for (const key of [
      'version', 'os', 'arch', 'runtime', 'runtime_version', 'duration_ms', 'outcome',
      'error_category', 'locale', 'is_ci', 'endpoint', 'ide', 'provider', 'runtime_mode', 'trigger',
      'count', 'has_summary', 'is_update', 'os_version', 'is_wsl', 'node_version', 'interactive',
      'install_method', 'bun_version', 'uv_version', 'claude_code_version', 'trial_days',
      'trial_variant', 'offer_surface', 'funnel_source', 'observation_count', 'session_count',
      'timeline_depth_days', 'has_session_summary', 'obs_type_bugfix', 'obs_type_other',
      'tokens_injected', 'tokens_saved_vs_naive', 'mode', 'search_strategy', 'observation_type',
      'hook', 'compression_ms', 'tokens_input', 'tokens_output', 'compression_ratio', 'model',
      'cost_usd', 'endpoint_class', 'db_observation_count', 'db_session_count', 'db_summary_count',
      'db_project_count', 'db_size_mb', 'install_age_days', 'obs_count_7d', 'obs_count_30d',
      'days_since_last_obs', 'result_count', 'chroma_available', 'fallback_reason',
      'invalid_output_class', 'consecutive_invalid_outputs', 'respawn_triggered', 'abort_reason',
      'outcomes_aborted', 'outcomes_aborted_deadline_exceeded', 'previous_shutdown',
      'previous_uptime_seconds', 'uptime_seconds', 'shutdown_reason', 'process_rss_mb',
      'heap_used_mb', 'hook_type', 'error_mode', 'consecutive_failures', 'threshold_tripped',
      'pre_latch_state', 'top_model', 'observed_model', 'observed_billing', 'skill_id',
      'skill_source', 'skill_trigger',
    ]) {
      expect(ALLOWED_PROPERTY_KEYS.has(key)).toBe(true);
    }
  });

  it('drops unknown keys silently', () => {
    const result = scrubProperties({
      version: '1.0.0',
      session_id: 'abc-123',
      random_key: 'value',
    });

    expect(result).toEqual({ version: '1.0.0' });
  });

  it('whitelist never contains sensitive keys', () => {
    for (const key of ['path', 'cwd', 'prompt', 'query', 'project_name', 'email', 'ip', 'args', 'skill', 'command']) {
      expect(ALLOWED_PROPERTY_KEYS.has(key)).toBe(false);
    }
  });

  it.each([
    [{ outcome: { status: 'ok', detail: '/some/path' }, version: '1.0.0' }, { version: '1.0.0' }],
    [{ outcome: ['a', 'b'], duration_ms: 5 }, { duration_ms: 5 }],
    [{ outcome: () => 'success', version: '1.0.0' }, { version: '1.0.0' }],
    [{ outcome: null }, {}],
    [{ outcome: undefined }, {}],
    [{ outcome: null, error_category: undefined, version: '1.0.0' }, { version: '1.0.0' }],
    [{ duration_ms: NaN, version: '1.0.0' }, { version: '1.0.0' }],
    [{ duration_ms: Infinity }, {}],
  ])('drops non-primitive and non-finite values from %j', (props, expected) => {
    expect(scrubProperties(props)).toEqual(expected);
  });

  it('truncates strings longer than 200 characters', () => {
    const long = 'x'.repeat(500);

    const result = scrubProperties({ outcome: long });

    expect(result.outcome).toBe('x'.repeat(200));
    expect((result.outcome as string).length).toBe(200);
  });

  it('leaves strings of exactly 200 characters untouched', () => {
    const exact = 'y'.repeat(200);

    const result = scrubProperties({ outcome: exact });

    expect(result.outcome).toBe(exact);
  });

  it('returns an empty object for empty input', () => {
    expect(scrubProperties({})).toEqual({});
  });

  it('redacts URL-shaped secrets even on a whitelisted key', () => {
    const result = scrubProperties({
      endpoint: 'https://api.example.com/v1/data?token=secret123',
      outcome: 'success',
    });

    expect(result.outcome).toBe('success');
    expect(String(result.endpoint)).not.toContain('secret123');
    expect(String(result.endpoint)).not.toContain('token=');
  });

  it('never throws on hostile input', () => {
    expect(scrubProperties(null as unknown as Record<string, unknown>)).toEqual({});
    expect(scrubProperties(undefined as unknown as Record<string, unknown>)).toEqual({});

    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'outcome', {
      enumerable: true,
      get() {
        throw new Error('gotcha');
      },
    });
    expect(scrubProperties(hostile)).toEqual({});
  });
});

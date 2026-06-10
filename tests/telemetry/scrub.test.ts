import { describe, it, expect } from 'bun:test';
import { scrubProperties, ALLOWED_PROPERTY_KEYS } from '../../src/services/telemetry/scrub';

describe('scrubProperties', () => {
  it('keeps whitelisted keys with primitive values', () => {
    const result = scrubProperties({
      version: '13.4.2',
      os: 'darwin',
      arch: 'arm64',
      runtime: 'bun',
      runtime_version: '1.2.0',
      duration_ms: 1234,
      outcome: 'success',
      error_category: 'timeout',
      locale: 'en-US',
      is_ci: false,
    });

    expect(result).toEqual({
      version: '13.4.2',
      os: 'darwin',
      arch: 'arm64',
      runtime: 'bun',
      runtime_version: '1.2.0',
      duration_ms: 1234,
      outcome: 'success',
      error_category: 'timeout',
      locale: 'en-US',
      is_ci: false,
    });
  });

  it('keeps the funnel/feature keys with primitive values', () => {
    const result = scrubProperties({
      endpoint: 'by-file',
      ide: 'claude-code',
      provider: 'claude',
      runtime_mode: 'worker',
      trigger: 'heartbeat',
      count: 7,
      has_summary: true,
      is_update: false,
    });

    expect(result).toEqual({
      endpoint: 'by-file',
      ide: 'claude-code',
      provider: 'claude',
      runtime_mode: 'worker',
      trigger: 'heartbeat',
      count: 7,
      has_summary: true,
      is_update: false,
    });
  });

  it('keeps the platform/toolchain keys with primitive values', () => {
    const result = scrubProperties({
      os_version: '10.0.22631',
      is_wsl: false,
      node_version: '22.14.0',
      interactive: true,
      install_method: 'npm',
      bun_version: '1.3.9',
      uv_version: '0.7.2',
      claude_code_version: '2.0.14',
    });

    expect(result).toEqual({
      os_version: '10.0.22631',
      is_wsl: false,
      node_version: '22.14.0',
      interactive: true,
      install_method: 'npm',
      bun_version: '1.3.9',
      uv_version: '0.7.2',
      claude_code_version: '2.0.14',
    });
  });

  it('keeps the depth/economics keys with primitive values', () => {
    const result = scrubProperties({
      observation_count: 50,
      session_count: 12,
      timeline_depth_days: 90,
      has_session_summary: true,
      obs_type_bugfix: 3,
      obs_type_other: 1,
      tokens_injected: 17914,
      tokens_saved_vs_naive: 144379,
      mode: 'code',
      search_strategy: 'timeline',
      observation_type: 'bugfix',
      hook: 'ingest',
      compression_ms: 2140,
      tokens_input: 5800,
      tokens_output: 420,
      compression_ratio: 13.81,
      model: 'claude-haiku-4-5',
    });

    expect(Object.keys(result)).toHaveLength(17);
    expect(result.tokens_saved_vs_naive).toBe(144379);
    expect(result.hook).toBe('ingest');
    expect(result.model).toBe('claude-haiku-4-5');
  });

  it('keeps the cost/endpoint keys with primitive values', () => {
    const result = scrubProperties({
      cost_usd: 0.0021,
      endpoint_class: 'openrouter',
    });

    expect(result).toEqual({
      cost_usd: 0.0021,
      endpoint_class: 'openrouter',
    });
  });

  it('keeps the install snapshot keys with primitive values', () => {
    const result = scrubProperties({
      db_observation_count: 92501,
      db_session_count: 5243,
      db_summary_count: 9698,
      db_project_count: 379,
      db_size_mb: 364.4,
      install_age_days: 104,
      obs_count_7d: 1887,
      obs_count_30d: 10357,
      days_since_last_obs: 0,
    });

    expect(Object.keys(result)).toHaveLength(9);
    expect(result.db_observation_count).toBe(92501);
    expect(result.install_age_days).toBe(104);
    expect(result.days_since_last_obs).toBe(0);
  });

  it('keeps the retrieval quality keys with primitive values', () => {
    const result = scrubProperties({
      result_count: 0,
      chroma_available: false,
      fallback_reason: 'chroma_connection',
    });

    expect(result).toEqual({
      result_count: 0,
      chroma_available: false,
      fallback_reason: 'chroma_connection',
    });
  });

  it('keeps the compression trust keys with primitive values', () => {
    const result = scrubProperties({
      fabrication_detected: true,
      fabricated_count: 2,
      invalid_output_class: 'poisoned',
      consecutive_invalid_outputs: 3,
      respawn_triggered: true,
      abort_reason: 'restart_guard',
    });

    expect(Object.keys(result)).toHaveLength(6);
    expect(result.fabrication_detected).toBe(true);
    expect(result.fabricated_count).toBe(2);
    expect(result.invalid_output_class).toBe('poisoned');
    expect(result.consecutive_invalid_outputs).toBe(3);
    expect(result.respawn_triggered).toBe(true);
    expect(result.abort_reason).toBe('restart_guard');
  });

  it('keeps the worker lifecycle keys with primitive values', () => {
    const result = scrubProperties({
      previous_shutdown: 'crash',
      previous_uptime_seconds: 86400,
      uptime_seconds: 3600,
      shutdown_reason: 'restart',
      process_rss_mb: 187,
      heap_used_mb: 92,
    });

    expect(Object.keys(result)).toHaveLength(6);
    expect(result.previous_shutdown).toBe('crash');
    expect(result.previous_uptime_seconds).toBe(86400);
    expect(result.uptime_seconds).toBe(3600);
    expect(result.shutdown_reason).toBe('restart');
    expect(result.process_rss_mb).toBe(187);
    expect(result.heap_used_mb).toBe(92);
  });

  it('keeps the hook failure keys with primitive values', () => {
    const result = scrubProperties({
      hook_type: 'observation',
      error_mode: 'worker_unavailable',
      consecutive_failures: 3,
      threshold_tripped: true,
    });

    expect(result).toEqual({
      hook_type: 'observation',
      error_mode: 'worker_unavailable',
      consecutive_failures: 3,
      threshold_tripped: true,
    });
  });

  it('drops unknown keys silently', () => {
    const result = scrubProperties({
      version: '1.0.0',
      session_id: 'abc-123',
      random_key: 'value',
    });

    expect(result).toEqual({ version: '1.0.0' });
  });

  it('drops sensitive-looking keys even if present', () => {
    const result = scrubProperties({
      path: '/Users/alice/secret-project/index.ts',
      cwd: '/Users/alice/secret-project',
      prompt: 'fix my auth bug',
      query: 'password reset flow',
      project_name: 'secret-project',
      email: 'alice@example.com',
      ip: '203.0.113.7',
      outcome: 'success',
    });

    expect(result).toEqual({ outcome: 'success' });
    expect(Object.keys(result)).not.toContain('path');
    expect(Object.keys(result)).not.toContain('cwd');
    expect(Object.keys(result)).not.toContain('prompt');
    expect(Object.keys(result)).not.toContain('query');
    expect(Object.keys(result)).not.toContain('project_name');
    expect(Object.keys(result)).not.toContain('email');
    expect(Object.keys(result)).not.toContain('ip');
  });

  it('whitelist never contains sensitive keys', () => {
    for (const key of ['path', 'cwd', 'prompt', 'query', 'project_name', 'email', 'ip']) {
      expect(ALLOWED_PROPERTY_KEYS.has(key)).toBe(false);
    }
  });

  it('drops nested objects on whitelisted keys', () => {
    const result = scrubProperties({
      outcome: { status: 'ok', detail: '/some/path' },
      version: '1.0.0',
    });

    expect(result).toEqual({ version: '1.0.0' });
  });

  it('drops arrays on whitelisted keys', () => {
    const result = scrubProperties({
      outcome: ['a', 'b'],
      duration_ms: 5,
    });

    expect(result).toEqual({ duration_ms: 5 });
  });

  it('drops functions on whitelisted keys', () => {
    const result = scrubProperties({
      outcome: () => 'success',
      version: '1.0.0',
    });

    expect(result).toEqual({ version: '1.0.0' });
  });

  it('drops null and undefined values', () => {
    const result = scrubProperties({
      outcome: null,
      error_category: undefined,
      version: '1.0.0',
    });

    expect(result).toEqual({ version: '1.0.0' });
  });

  it('drops NaN and Infinity', () => {
    const result = scrubProperties({
      duration_ms: NaN,
      version: '1.0.0',
    });

    expect(result).toEqual({ version: '1.0.0' });

    expect(scrubProperties({ duration_ms: Infinity })).toEqual({});
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

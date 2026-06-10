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

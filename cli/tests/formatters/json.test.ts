import { describe, it, expect } from 'bun:test';
import { jsonOutput, jsonError } from '../../src/formatters/json.ts';

// ─── jsonOutput ───────────────────────────────────────────────────────────

describe('jsonOutput', () => {
  it('produces valid JSON', () => {
    const result = jsonOutput({ message: 'hello' });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('ok field is true', () => {
    const result = JSON.parse(jsonOutput({ value: 42 }));
    expect(result.ok).toBe(true);
  });

  it('data field contains the provided value', () => {
    const payload = { id: 7, title: 'test' };
    const result = JSON.parse(jsonOutput(payload));
    expect(result.data).toEqual(payload);
  });

  it('error field is absent on success', () => {
    const result = JSON.parse(jsonOutput({ x: 1 }));
    expect(result.error).toBeUndefined();
  });

  it('meta field is absent when not provided', () => {
    const result = JSON.parse(jsonOutput({ x: 1 }));
    expect(result.meta).toBeUndefined();
  });

  it('meta field is present when provided', () => {
    const meta = { count: 5, hasMore: false, offset: 0, limit: 20 };
    const result = JSON.parse(jsonOutput({ items: [] }, meta));
    expect(result.meta).toEqual(meta);
  });

  it('handles an array as data', () => {
    const items = [1, 2, 3];
    const result = JSON.parse(jsonOutput(items));
    expect(result.data).toEqual(items);
  });

  it('handles a null data value', () => {
    const result = JSON.parse(jsonOutput(null));
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it('handles a string as data', () => {
    const result = JSON.parse(jsonOutput('plain string'));
    expect(result.data).toBe('plain string');
  });

  it('schema stability — always has ok and data at minimum', () => {
    const result = JSON.parse(jsonOutput({}));
    const keys = Object.keys(result);
    expect(keys).toContain('ok');
    expect(keys).toContain('data');
  });
});

// ─── jsonError ────────────────────────────────────────────────────────────

describe('jsonError', () => {
  it('produces valid JSON', () => {
    const result = jsonError('something failed', 3);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('ok field is false', () => {
    const result = JSON.parse(jsonError('error message', 3));
    expect(result.ok).toBe(false);
  });

  it('data field is null', () => {
    const result = JSON.parse(jsonError('error message', 3));
    expect(result.data).toBeNull();
  });

  it('error field contains the provided message', () => {
    const result = JSON.parse(jsonError('query too long', 3));
    expect(result.error).toBe('query too long');
  });

  it('code field matches the provided exit code', () => {
    const result = JSON.parse(jsonError('not found', 4));
    expect(result.code).toBe(4);
  });

  it('schema stability — error response always has ok, data, error, code', () => {
    const result = JSON.parse(jsonError('any', 1));
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('code');
  });

  it('handles an empty error string', () => {
    const result = JSON.parse(jsonError('', 5));
    expect(result.error).toBe('');
    expect(result.ok).toBe(false);
  });

  it('code 0 is preserved (SUCCESS code can theoretically appear)', () => {
    const result = JSON.parse(jsonError('unexpected', 0));
    expect(result.code).toBe(0);
  });
});

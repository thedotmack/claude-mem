import { describe, it, expect } from 'bun:test';
import type { Request } from 'express';
import { BaseRouteHandler } from '../../../src/services/worker/http/BaseRouteHandler.js';

// firstString / getPlatformSourceFromRequest are protected; a thin subclass
// exposes them for testing the untrusted-input coercion path.
class TestRoutes extends BaseRouteHandler {
  static first(value: unknown): string | undefined {
    return (BaseRouteHandler as any).firstString(value);
  }
  platform(req: Request): string {
    return this.getPlatformSourceFromRequest(req);
  }
}

function makeRequest(query: Record<string, unknown>): Request {
  return {
    path: '/api/test',
    query,
    body: {},
    get: () => undefined,
  } as any;
}

describe('BaseRouteHandler.firstString', () => {
  it('returns the string for a plain value', () => {
    expect(TestRoutes.first('cursor')).toBe('cursor');
  });

  it('unwraps a single-level array (Express repeated query key)', () => {
    expect(TestRoutes.first(['codex', 'claude'])).toBe('codex');
  });

  it('returns undefined for empty / non-string leaves', () => {
    expect(TestRoutes.first('')).toBeUndefined();
    expect(TestRoutes.first('   ')).toBeUndefined();
    expect(TestRoutes.first(undefined)).toBeUndefined();
    expect(TestRoutes.first(42)).toBeUndefined();
    expect(TestRoutes.first([])).toBeUndefined();
  });

  it('walks a few levels of nesting to the leaf', () => {
    expect(TestRoutes.first([[['cursor']]])).toBe('cursor');
  });

  it('does NOT overflow the stack on a deeply nested array', () => {
    // Build a 100k-deep nested array: the old recursive firstString threw
    // "RangeError: Maximum call stack size exceeded" here.
    let nested: unknown = 'claude';
    for (let i = 0; i < 100_000; i++) nested = [nested];
    expect(() => TestRoutes.first(nested)).not.toThrow();
    // Past the depth cap the value is treated as absent.
    expect(TestRoutes.first(nested)).toBeUndefined();
  });

  it('does NOT overflow the stack on a self-referential array', () => {
    const cyclic: unknown[] = [];
    cyclic[0] = cyclic;
    expect(() => TestRoutes.first(cyclic)).not.toThrow();
    expect(TestRoutes.first(cyclic)).toBeUndefined();
  });

  it('never crashes normalizing a hostile platformSource query param', () => {
    let nested: unknown = 'x';
    for (let i = 0; i < 100_000; i++) nested = [nested];
    const routes = new TestRoutes();
    // Falls back to the default source instead of crashing request handling.
    expect(() => routes.platform(makeRequest({ platformSource: nested }))).not.toThrow();
    expect(routes.platform(makeRequest({ platformSource: nested }))).toBe('claude');
  });
});

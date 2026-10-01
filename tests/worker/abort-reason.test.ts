import { describe, expect, it } from 'bun:test';
import {
  abortCategoryOf,
  normalizeAbortReason,
  PRESERVED_ABORT_CATEGORIES,
} from '../../src/services/worker/session/abort-reason.js';

// One authority for abort reasons (#3461): the exit handler's preserve list and
// the telemetry enum read the same module, so they cannot drift apart.
describe('abort-reason authority', () => {
  it('reads the category before the first colon', () => {
    expect(abortCategoryOf('quota:weekly')).toBe('quota');
    expect(abortCategoryOf('drift:observer_schema')).toBe('drift');
    expect(abortCategoryOf(null)).toBe('');
  });

  it.each([
    ['idle', 'idle'],
    ['shutdown', 'shutdown'],
    ['overflow:recycle', 'overflow'],
    ['restart-guard', 'restart_guard'],
    ['quota:quota_exhausted', 'quota'],
    ['rate_limit:rate_limit', 'rate_limit'],
    ['auth:observer_text', 'auth'],
    ['provider_switch', 'provider_switch'],
    ['output_retry:prose', 'output_retry'],
    ['drift:observer_schema', 'drift'],
    ['transport:deadline_exceeded', 'deadline_exceeded'],
    // Every other transport pause stays 'none' (#4278).
    ['transport:transient', 'none'],
    ['something-new', 'none'],
    [null, 'none'],
  ] as const)('reports %p as %p, never the raw string', (reason, expected) => {
    expect(normalizeAbortReason(reason)).toBe(expected);
  });

  it('preserves every pause that keeps its buffered work, drift included', () => {
    for (const category of ['quota', 'rate_limit', 'auth', 'overflow', 'provider_switch', 'transport', 'output_retry', 'drift']) {
      expect(PRESERVED_ABORT_CATEGORIES.has(category)).toBe(true);
    }
    for (const category of ['idle', 'shutdown', 'restart-guard', '']) {
      expect(PRESERVED_ABORT_CATEGORIES.has(category)).toBe(false);
    }
  });
});

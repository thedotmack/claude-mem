import { describe, expect, it } from 'bun:test';
import { normalizeAbortReason } from '../../src/services/worker/session/abort-reason.js';

// One authority for abort reasons (#3461): the exit handler's preserve list and
// the telemetry enum read the same module, so they cannot drift apart.
describe('abort-reason authority', () => {
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
});

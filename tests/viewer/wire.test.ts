import { describe, expect, it } from 'bun:test';
import { parseViewRoute, wireHash } from '../../src/ui/viewer/utils/sessions';
import { API_ENDPOINTS } from '../../src/ui/viewer/constants/api';
import { wireTraceUrl } from '../../src/ui/viewer/hooks/useWireGateway';
import {
  WIRE_TRACE_KEPT_CALLS,
  describeWireFailure,
  formatCacheRatio,
  formatTokenCount,
  mergeTraceCalls,
  type WireTraceCall,
} from '../../src/ui/viewer/utils/wire';

function call(id: string, seq: number, time: string, overrides: Partial<WireTraceCall> = {}): WireTraceCall {
  return {
    id, seq, time, agentId: 'codex', routeId: 'codex', protocol: 'openai-responses', method: 'POST', path: '/v1/responses',
    kind: 'turn', sessionId: 's', done: false, hasBodies: false, ...overrides,
  };
}

describe('the Wire route', () => {
  it('parses #/wire and round-trips its hash', () => {
    expect(parseViewRoute(wireHash())).toEqual({ view: 'wire' });
    expect(parseViewRoute('#/wire/extra')).toEqual({ view: 'timeline' });
  });
});

describe('the worker routes the page calls', () => {
  it('are all on the worker (same origin), never the gateway port', () => {
    const wireEndpoints = Object.entries(API_ENDPOINTS).filter(([name]) => name.startsWith('WIRE_'));
    expect(wireEndpoints.length).toBeGreaterThanOrEqual(7);
    for (const [, path] of wireEndpoints) expect(path).toMatch(/^\/api\/wire\//);
  });

  it('asks the live feed to wait for a change (wait=1), from the last seq of the same feed', () => {
    expect(wireTraceUrl(0, null)).toBe('/api/wire/trace?after=0&wait=1');
    expect(wireTraceUrl(12, 'feed a')).toBe('/api/wire/trace?after=12&wait=1&feed=feed%20a');
  });
});

describe('mergeTraceCalls', () => {
  it('replaces a changed call and keeps newest first', () => {
    const first = mergeTraceCalls([], null, { feedId: 'f1', seq: 2, now: '', calls: [call('a', 1, '2026-10-24T10:00:00Z'), call('b', 2, '2026-10-24T10:00:01Z')] });
    expect(first.map(entry => entry.id)).toEqual(['b', 'a']);
    const second = mergeTraceCalls(first, 'f1', { feedId: 'f1', seq: 3, now: '', calls: [call('a', 3, '2026-10-24T10:00:00Z', { done: true, status: 200 })] });
    expect(second.map(entry => [entry.id, entry.done])).toEqual([['b', false], ['a', true]]);
  });

  it('starts over when the gateway restarted (its seq went back)', () => {
    const before = mergeTraceCalls([], null, { feedId: 'f1', seq: 40, now: '', calls: [call('old', 40, '2026-10-24T10:00:00Z')] });
    const after = mergeTraceCalls(before, 'f1', { feedId: 'f2', seq: 1, now: '', calls: [call('new', 1, '2026-10-24T11:00:00Z')] });
    expect(after.map(entry => entry.id)).toEqual(['new']);
  });

  it('starts over when the restarted gateway is already past the old seq (no stale "in flight" rows)', () => {
    const before = mergeTraceCalls([], null, { feedId: 'f1', seq: 5, now: '', calls: [call('stuck', 5, '2026-10-24T10:00:00Z', { done: false })] });
    const after = mergeTraceCalls(before, 'f1', {
      feedId: 'f2', seq: 9, now: '', calls: [call('first-after-restart', 1, '2026-10-24T11:00:00Z'), call('later', 9, '2026-10-24T11:00:05Z')],
    });
    expect(after.map(entry => entry.id)).toEqual(['later', 'first-after-restart']);
  });

  it("keeps at most the gateway's own 60 calls", () => {
    const calls = Array.from({ length: WIRE_TRACE_KEPT_CALLS + 5 }, (_, index) => call(`c${index}`, index + 1, new Date(Date.UTC(2026, 9, 24, 10, 0, index)).toISOString()));
    const merged = mergeTraceCalls([], null, { feedId: 'f1', seq: calls.length, now: '', calls });
    expect(merged).toHaveLength(WIRE_TRACE_KEPT_CALLS);
    expect(merged[0].id).toBe(`c${calls.length - 1}`);
  });
});

describe('formatting', () => {
  it('formats token counts and cache ratios', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(42_000)).toBe('42k');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
    expect(formatCacheRatio({ requests: 0, cacheRead: 0, cacheWrite: 0, readWriteRatio: null })).toBe('no requests');
    expect(formatCacheRatio({ requests: 2, cacheRead: 5, cacheWrite: 0, readWriteRatio: null })).toBe('no cache writes');
    expect(formatCacheRatio({ requests: 2, cacheRead: 900, cacheWrite: 100, readWriteRatio: 9 })).toBe('9.0:1');
  });

  it("describes a failure by the worker's error, the gateway's {type, message}, or the status", async () => {
    expect(await describeWireFailure(Response.json({ error: 'nope' }, { status: 403 }))).toBe('nope');
    expect(await describeWireFailure(Response.json({ error: { type: 'x', message: 'gone' } }, { status: 404 }))).toBe('gone');
    expect(await describeWireFailure(new Response('<html>', { status: 502 }))).toBe('the worker answered HTTP 502');
  });
});

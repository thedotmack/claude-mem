import { describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { buildCmemCorrelationHeader, CMEM_CORRELATION_MAX_HEADER_BYTES } from '../../src/services/worker/cmem-request-correlation.js';

const key = (seed: string) => createHash('sha256').update(seed).digest('hex');

describe('cmem gateway request correlation header', () => {
  it('holds exactly request_id, attempt and at most four distinct SHA-256 event keys', () => {
    const requestId = randomUUID();
    const keys = ['a', 'b', 'a', 'c', 'd', 'e'].map(key);
    const value = buildCmemCorrelationHeader({ requestId, attempt: 3, eventKeys: keys });
    expect(JSON.parse(value)).toEqual({ request_id: requestId, attempt: 3, event_keys: [key('a'), key('b'), key('c'), key('d')] });
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(CMEM_CORRELATION_MAX_HEADER_BYTES);
  });

  it('drops anything that is not a lowercase SHA-256 key instead of sending it', () => {
    const value = JSON.parse(buildCmemCorrelationHeader({
      requestId: randomUUID(), attempt: 1,
      eventKeys: ['/Users/me/shot.png', 'event1_image1', key('x').toUpperCase(), key('ok')],
    }));
    expect(value.event_keys).toEqual([key('ok')]);
  });

  it('rejects malformed request IDs and attempts as programming errors', () => {
    expect(() => buildCmemCorrelationHeader({ requestId: 'req_1', attempt: 1, eventKeys: [] })).toThrow();
    for (const attempt of [0, -1, 1.5, 1001]) {
      expect(() => buildCmemCorrelationHeader({ requestId: randomUUID(), attempt, eventKeys: [] })).toThrow();
    }
  });
});

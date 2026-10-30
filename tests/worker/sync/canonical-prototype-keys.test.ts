import { describe, expect, it } from 'bun:test';
import { canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';

describe('canonical payload property preservation', () => {
  it('retains ordinary JSON keys named __proto__ at every depth', () => {
    const input = JSON.parse('{"__proto__":{"kept":1},"nested":{"__proto__":"evidence"}}');
    const output = JSON.parse(canonicalJson(input));
    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output.__proto__).toEqual({ kept: 1 });
    expect(output.nested.__proto__).toBe('evidence');
  });
  it('does not hash distinct payloads as identical after dropping a property', () => {
    expect(sha256Base64Url(canonicalJson(JSON.parse('{"__proto__":"one"}'))))
      .not.toBe(sha256Base64Url(canonicalJson(JSON.parse('{"__proto__":"two"}'))));
  });
});

import { buildContentOperation, parseCanonicalOperation } from '../../../src/services/sync/CanonicalContent.js';
import * as api from '../../../services/sync-api/src/canonical-content.js';
import * as hub from '../../../workers/sync-hub/src/canonical-content.js';

for (const [name, server] of [['sync-api', api], ['sync-hub', hub]] as const) it(`accepts prototype-named metadata through ${name} validation`, async () => {
  const metadata = JSON.parse('{"__proto__":{"kept":"owned"},"nested":{"__proto__":"evidence"}}');
  const operation = buildContentOperation({kind:'observation',originDeviceId:'owned-device',originLocalId:'1',entityRev:'1',
    payload:{memory_session_id:'owned-memory',project:'owned-project',created_at:'2026-10-05T12:00:00.000Z',created_at_epoch:'1791201600000',metadata}});
  const client = parseCanonicalOperation(operation);
    const received = await server.parseCanonicalOperation(operation);
    expect(server.canonicalJson(metadata)).toBe(canonicalJson(metadata));
    expect(received.body.payload?.metadata).toEqual(client.payload?.metadata);
    expect(received.serialized).toBe(operation.body);
});

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { WIRE_GATEWAY_VERSION } from '../../src/services/wire-gateway/router.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

let gateway: StartedWireGateway;

beforeAll(async () => {
  gateway = await startWireGatewayForTest();
});

afterAll(async () => {
  await gateway.stop();
});

describe('wire gateway identity probe', () => {
  it('GET / and GET /wire/identity answer the same identity, with a per-process instance id', async () => {
    const root = await fetch(`${gateway.baseUrl}/`);
    const identity = await fetch(`${gateway.baseUrl}/wire/identity`);
    expect(root.status).toBe(200);
    expect(identity.status).toBe(200);

    const rootBody = await root.json() as Record<string, unknown>;
    const identityBody = await identity.json() as Record<string, unknown>;
    expect(rootBody).toEqual(identityBody);
    expect(Object.keys(rootBody).sort()).toEqual(['instance', 'name', 'version']);
    expect(rootBody.name).toBe('claude-mem-wire-gateway');
    expect(rootBody.version).toBe(WIRE_GATEWAY_VERSION);
    expect(rootBody.instance).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('wire gateway router skeleton', () => {
  for (const path of ['/r/test/v1/messages', '/v1/traces', '/v1/claude-mem/events', '/mcp', '/wire/status', '/nope']) {
    it(`${path} answers 404 not_found_error until its phase lands`, async () => {
      const response = await fetch(`${gateway.baseUrl}${path}`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe('not_found_error');
      expect(typeof body.error.message).toBe('string');
    });
  }
});

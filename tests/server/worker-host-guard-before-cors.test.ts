// The Host (DNS-rebinding) guard runs before CORS, and it has to: origin-policy.ts
// says `isSameHostOrigin` and `isOwnPageOrigin` are "safe only behind the Host
// check, which has already refused any Host the operator did not trust". A
// refactor that mounted CORS first would let a rebound page qualify as the
// worker's own origin. A request to an untrusted Host must therefore be refused
// with no Access-Control-Allow-Origin header, even when its Origin would pass
// the CORS check on its own.

import { describe, expect, it } from 'bun:test';
import { request } from 'node:http';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';

function options(): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '/test/worker-service.cjs',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    originPolicy: { allowedOrigins: [], workerHost: '' },
  };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(port: number, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/health', headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('worker Host guard runs before CORS', () => {
  it('refuses a rebound Host without echoing an allowed-origin CORS header', async () => {
    const server = new Server(options());
    const port = await listenOnEphemeralPort(server);

    // The Host names a name the operator never trusted (DNS rebinding); the
    // Origin is one CORS would accept (loopback), so only the Host guard can
    // refuse this request, and it must refuse it before CORS answers.
    const reply = await get(port, {
      Host: 'attacker.example',
      Origin: `http://127.0.0.1:${port}`,
    });

    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.parse(reply.body).error).toBe('Forbidden');

    // A trusted Host on the same server still reaches the route and gets CORS.
    const allowed = await get(port, {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${port}`);

    await server.close();
  });
});
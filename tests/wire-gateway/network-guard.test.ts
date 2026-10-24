import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  FORWARDING_HEADERS,
  checkLoopbackRequest,
  isForeignOrigin,
  isLoopbackAddress,
  isOwnHost,
} from '../../src/services/wire-gateway/network-guard.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

let gateway: StartedWireGateway;

beforeAll(async () => {
  gateway = await startWireGatewayForTest();
});

afterAll(async () => {
  await gateway.stop();
});

function getRoot(headers: Record<string, string>): Promise<Response> {
  return fetch(`${gateway.baseUrl}/`, { headers });
}

function expectNoCorsHeaders(response: Response): void {
  for (const name of response.headers.keys()) {
    expect(name.toLowerCase().startsWith('access-control-')).toBe(false);
  }
}

describe('wire gateway network guard (over HTTP)', () => {
  it('answers a plain loopback agent request', async () => {
    const response = await getRoot({});
    expect(response.status).toBe(200);
    expectNoCorsHeaders(response);
  });

  it('answers an agent (no browser marks) even under an unknown Host name', async () => {
    const response = await getRoot({ host: 'rebound.example.com' });
    expect(response.status).toBe(200);
  });

  for (const browserMark of [
    { origin: 'http://rebound.example.com' },
    { 'sec-fetch-mode': 'cors' },
    { 'sec-fetch-site': 'same-origin' },
    { 'user-agent': 'Mozilla/5.0 (Macintosh)' },
  ]) {
    it(`refuses DNS rebinding: a browser (${Object.keys(browserMark)[0]}) under a web site's Host gets 403`, async () => {
      const response = await getRoot({ host: 'rebound.example.com', ...browserMark });
      expect(response.status).toBe(403);
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe('permission_error');
      expect(body.error.message).toContain('rebound.example.com');
      expectNoCorsHeaders(response);
    });
  }

  it('lets a browser in when it uses localhost', async () => {
    const response = await getRoot({ host: `localhost:${gateway.port}`, 'user-agent': 'Mozilla/5.0', origin: 'http://localhost:5173' });
    expect(response.status).toBe(200);
    expectNoCorsHeaders(response);
  });

  it('refuses a foreign Origin with 403', async () => {
    const response = await getRoot({ origin: 'https://evil.example.com' });
    expect(response.status).toBe(403);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('https://evil.example.com');
  });

  it('lets desktop-app and extension origins pass (not web pages)', async () => {
    for (const origin of ['vscode-webview://abc', 'chrome-extension://xyz', 'null']) {
      const response = await getRoot({ origin });
      expect(response.status).toBe(200);
    }
  });

  for (const header of FORWARDING_HEADERS) {
    it(`refuses a request forwarded by a proxy (${header})`, async () => {
      const response = await getRoot({ [header]: '203.0.113.9' });
      expect(response.status).toBe(403);
      const body = await response.json() as { error: { message: string } };
      expect(body.error.message).toContain(header);
    });
  }
});

describe('wire gateway network guard (unit)', () => {
  const request = (headers: Record<string, string> = {}) => new Request('http://127.0.0.1/', { headers });

  it('refuses a peer that is not loopback', () => {
    const refusal = checkLoopbackRequest(request(), { peerAddress: '192.168.1.20', listenHost: '127.0.0.1' });
    expect(refusal).toContain('192.168.1.20');
  });

  it('refuses an unknown peer (socket already gone)', () => {
    expect(checkLoopbackRequest(request(), { peerAddress: null, listenHost: '127.0.0.1' })).toContain('an unknown address');
  });

  it('accepts IPv4, IPv6 and IPv4-mapped loopback peers', () => {
    for (const peerAddress of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
      expect(checkLoopbackRequest(request(), { peerAddress, listenHost: '127.0.0.1' })).toBeNull();
    }
  });

  it('isLoopbackAddress', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('localhost')).toBe(false);
  });

  it('isOwnHost: IPs, localhost, *.localhost, container names, the listen host', () => {
    for (const host of ['127.0.0.1:37677', '[::1]:37677', '192.168.1.4', 'localhost', 'app.localhost:80', 'host.docker.internal', 'LOCALHOST.']) {
      expect(isOwnHost(host, '127.0.0.1')).toBe(true);
    }
    expect(isOwnHost('mybox.example:1', 'mybox.example')).toBe(true);
    expect(isOwnHost('rebound.example.com', '127.0.0.1')).toBe(false);
  });

  it('isForeignOrigin', () => {
    expect(isForeignOrigin(null, '127.0.0.1:1')).toBe(false);
    expect(isForeignOrigin('http://localhost:3000', '127.0.0.1:1')).toBe(false);
    expect(isForeignOrigin('http://tauri.localhost', '127.0.0.1:1')).toBe(false);
    expect(isForeignOrigin('http://127.0.0.1:9999', '127.0.0.1:1')).toBe(false);
    expect(isForeignOrigin('http://[::1]:9999', '127.0.0.1:1')).toBe(false);
    // The page served at the address the request names is the request's own origin.
    expect(isForeignOrigin('http://10.0.0.5:37677', '10.0.0.5:37677')).toBe(false);
    expect(isForeignOrigin('https://evil.example.com', '127.0.0.1:1')).toBe(true);
    expect(isForeignOrigin('http://10.0.0.5:8080', '127.0.0.1:1')).toBe(true);
    expect(isForeignOrigin('app://bundle', '127.0.0.1:1')).toBe(false);
  });
});

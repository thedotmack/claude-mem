// SPDX-License-Identifier: Apache-2.0
//
// #2572 — the server runtime must emit hardening response headers. The worker
// (loopback-only) leaves them off. We assert the opt-in `securityHeaders`
// option installs the headers on every response and is absent by default.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';

function baseOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '/test/worker-service.cjs',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    ...overrides,
  };
}

describe('Server security headers (#2572)', () => {
  let server: Server | null = null;
  let spies: ReturnType<typeof spyOn>[] = [];

  afterEach(async () => {
    spies.forEach(s => s.mockRestore());
    spies = [];
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  it('emits hardening headers on a server response when securityHeaders=true', async () => {
    spies = [spyOn(logger, 'info').mockImplementation(() => {})];
    server = new Server(baseOptions({ securityHeaders: true }));
    const port = 41000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('does NOT emit the hardening headers by default (worker runtime)', async () => {
    spies = [spyOn(logger, 'info').mockImplementation(() => {})];
    server = new Server(baseOptions());
    const port = 41000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  });
});

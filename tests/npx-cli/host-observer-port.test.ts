import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildHostObserverSettings,
  hostObserverCandidatePorts,
  probeHostObserverPort,
  resolveHostObserverPort,
} from '../../src/npx-cli/cmem-memory-credentials.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error('missing listen address'));
        return;
      }
      resolve(address.port);
    });
    server.once('error', reject);
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('host observer port resolution', () => {
  it('moves candidates off the worker port, including a numeric worker port', () => {
    expect(hostObserverCandidatePorts('37777', {} as NodeJS.ProcessEnv)).toEqual([37778]);
    expect(hostObserverCandidatePorts(37777, {} as NodeJS.ProcessEnv)).toEqual([37778]);
    expect(hostObserverCandidatePorts('37742', {} as NodeJS.ProcessEnv)).toEqual([37777, 37778]);
    expect(hostObserverCandidatePorts('37777', { CLAUDE_MEM_HOST_OBSERVER_PORT: '39999' } as NodeJS.ProcessEnv)).toEqual([39999]);
  });

  it('persists a live OpenAI-compatible observer instead of a dead URL', () => {
    const probe = (port: number) => (port === 37778 ? 'observer' : 'free' as const);
    expect(resolveHostObserverPort('37777', {} as NodeJS.ProcessEnv, probe)).toBe('37778');
    expect(resolveHostObserverPort(37777, {} as NodeJS.ProcessEnv, probe)).toBe('37778');
  });

  it('fails install resolution when nothing OpenAI-compatible is listening', () => {
    expect(() => resolveHostObserverPort('37777', {} as NodeJS.ProcessEnv, () => 'free')).toThrow(
      /No OpenAI-compatible host observer is listening/,
    );
  });

  it('never persists an occupied non-observer port', () => {
    expect(() => resolveHostObserverPort('37777', {} as NodeJS.ProcessEnv, () => 'occupied')).toThrow(
      /No OpenAI-compatible host observer is listening/,
    );
  });

  it('fails when CLAUDE_MEM_HOST_OBSERVER_PORT is occupied by a non-observer', () => {
    expect(() =>
      resolveHostObserverPort('37777', { CLAUDE_MEM_HOST_OBSERVER_PORT: '39999' } as NodeJS.ProcessEnv, () => 'occupied'),
    ).toThrow(/CLAUDE_MEM_HOST_OBSERVER_PORT=39999 is occupied/);
  });

  it('fails when CLAUDE_MEM_HOST_OBSERVER_PORT has no listener', () => {
    expect(() =>
      resolveHostObserverPort('37777', { CLAUDE_MEM_HOST_OBSERVER_PORT: '39999' } as NodeJS.ProcessEnv, () => 'free'),
    ).toThrow(/CLAUDE_MEM_HOST_OBSERVER_PORT=39999 has nothing listening/);
  });

  it('uses an explicit override after confirming an observer is listening', () => {
    expect(
      resolveHostObserverPort(
        '37777',
        { CLAUDE_MEM_HOST_OBSERVER_PORT: '39999' } as NodeJS.ProcessEnv,
        () => 'observer',
      ),
    ).toBe('39999');
  });

  it('builds host settings only after a probe succeeds', () => {
    const updates = buildHostObserverSettings(
      'grok-bot',
      { CLAUDE_MEM_WORKER_PORT: '37777' },
      {} as NodeJS.ProcessEnv,
      (port) => (port === 37778 ? 'observer' : 'free'),
    );
    expect(updates).toEqual({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'http://127.0.0.1:37778/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'grok-bot',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'host-observer-local',
    });
  });

  it('classifies a real OpenAI-compatible listener as observer and an unrelated listener as occupied', async () => {
    const observer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-bot', object: 'model' }] }));
    });
    const occupied = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('occupied-loopback-port');
    });
    try {
      const observerPort = await listen(observer);
      const occupiedPort = await listen(occupied);
      expect(await probeHostObserverPort(observerPort)).toBe('observer');
      expect(await probeHostObserverPort(occupiedPort)).toBe('occupied');
    } finally {
      await close(observer);
      await close(occupied);
    }
  });
});

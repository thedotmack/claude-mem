import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'fs';
import { paths, wireGatewaySubdirPath } from '../../src/shared/paths.js';
import { WIRE_GATEWAY_VERSION } from '../../src/services/wire-gateway/router.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

const started: StartedWireGateway[] = [];

async function startGateway(...args: Parameters<typeof startWireGatewayForTest>): Promise<StartedWireGateway> {
  const gateway = await startWireGatewayForTest(...args);
  started.push(gateway);
  return gateway;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map(gateway => gateway.stop()));
});

/** A body that sends `first`, waits `holdMs`, sends `last` and ends. */
function slowStream(first: string, last: string, holdMs: number): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(first));
      await new Promise(resolve => setTimeout(resolve, holdMs));
      controller.enqueue(encoder.encode(last));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

/** A body that sends `first` and then never ends. */
function hangingStream(first: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('wire gateway lifecycle', () => {
  it('starts on loopback, answers, and stops listening on stop', async () => {
    const gateway = await startGateway();
    const response = await fetch(`${gateway.baseUrl}/`);
    expect(response.status).toBe(200);

    await gateway.stop();
    await expect(fetch(`${gateway.baseUrl}/`)).rejects.toThrow();
  });

  it('writes 0600 PID, port and state files under a 0700 state dir, and removes them on stop', async () => {
    const gateway = await startGateway({ persistRuntimeState: true });

    for (const file of [paths.wireGatewayPid(), paths.wireGatewayPort(), paths.wireGatewayRuntime(), paths.wireGatewayProcessRegistry()]) {
      expect(existsSync(file)).toBe(true);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== 'win32') {
      expect(statSync(wireGatewaySubdirPath('state')).mode & 0o777).toBe(0o700);
      expect(statSync(wireGatewaySubdirPath('tmp')).mode & 0o777).toBe(0o700);
    }

    const state = JSON.parse(readFileSync(paths.wireGatewayRuntime(), 'utf-8'));
    expect(state).toMatchObject({ name: 'claude-mem-wire-gateway', version: WIRE_GATEWAY_VERSION, pid: process.pid, port: gateway.port });
    expect(readFileSync(paths.wireGatewayPort(), 'utf-8').trim()).toBe(String(gateway.port));
    const registry = JSON.parse(readFileSync(paths.wireGatewayProcessRegistry(), 'utf-8'));
    expect(registry.processes['wire-gateway']).toMatchObject({ pid: process.pid, type: 'wire-gateway' });

    await gateway.stop();
    for (const file of [paths.wireGatewayPid(), paths.wireGatewayPort(), paths.wireGatewayRuntime()]) {
      expect(existsSync(file)).toBe(false);
    }
    const registryAfter = JSON.parse(readFileSync(paths.wireGatewayProcessRegistry(), 'utf-8'));
    expect(registryAfter.processes['wire-gateway']).toBeUndefined();
  });

  it('drains: stop waits for an in-flight stream to finish, and the client gets every byte', async () => {
    const gateway = await startGateway({
      drainTimeoutMs: 5_000,
      fetchHandler: () => slowStream('data: first\n\n', 'data: last\n\n', 400),
    });

    const response = await fetch(`${gateway.baseUrl}/stream`);
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toBe('data: first\n\n');
    expect(gateway.service.pendingRequests).toBe(1);

    const stopStartedAt = Date.now();
    let stopFinished = false;
    const stopping = gateway.stop().then(() => {
      stopFinished = true;
    });

    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('data: last\n\n');

    await stopping;
    expect(stopFinished).toBe(true);
    // The stream held for 400 ms after stop began; stop could not return before it ended.
    expect(Date.now() - stopStartedAt).toBeGreaterThanOrEqual(300);
  });

  it('force-closes a stream that outlives the drain timeout', async () => {
    const gateway = await startGateway({
      drainTimeoutMs: 200,
      fetchHandler: () => hangingStream('data: first\n\n'),
    });

    const response = await fetch(`${gateway.baseUrl}/stream`);
    const reader = response.body!.getReader();
    await reader.read();

    const stopStartedAt = Date.now();
    await gateway.stop();
    const stopTookMs = Date.now() - stopStartedAt;
    expect(stopTookMs).toBeGreaterThanOrEqual(150);
    expect(stopTookMs).toBeLessThan(3_000);

    // The client's stream ends or errors; it never hangs.
    const outcome = await reader.read().then(() => 'ended', () => 'errored');
    expect(['ended', 'errored']).toContain(outcome);
  });

  it('refuses to start, and binds nothing, on Bun older than 1.3.6', async () => {
    await expect(startWireGatewayForTest({ bunVersion: '1.3.5' })).rejects.toThrow(
      'claude-mem wire gateway needs Bun ≥ 1.3.6 (found 1.3.5). Run: bun upgrade',
    );
  });
});

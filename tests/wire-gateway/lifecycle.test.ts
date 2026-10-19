import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureWireGatewayDirs, paths, wireGatewaySubdirPath } from '../../src/shared/paths.js';
import { WIRE_GATEWAY_VERSION } from '../../src/services/wire-gateway/router.js';
import {
  removeWireGatewayStateIfOwnedBy,
  stopRunningWireGateway,
} from '../../src/services/wire-gateway/WireGatewayService.js';
import { captureProcessStartToken, type PidInfo } from '../../src/supervisor/process-registry.js';
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

/** Writes PID/port/runtime files the way a gateway instance does. */
function writeInstanceStateFiles(pidInfo: PidInfo): void {
  ensureWireGatewayDirs();
  writeFileSync(paths.wireGatewayPid(), JSON.stringify(pidInfo));
  writeFileSync(paths.wireGatewayPort(), `${pidInfo.port}\n`);
  writeFileSync(paths.wireGatewayRuntime(), JSON.stringify({ pid: pidInfo.pid, port: pidInfo.port, startedAt: pidInfo.startedAt }));
}

function removeStateFiles(): void {
  for (const file of [paths.wireGatewayPid(), paths.wireGatewayPort(), paths.wireGatewayRuntime()]) rmSync(file, { force: true });
}

describe('wire gateway state-file ownership on stop', () => {
  afterEach(removeStateFiles);

  const replacement: PidInfo = { pid: process.pid, port: 40002, startedAt: '2026-10-15T00:00:02.000Z', startToken: captureProcessStartToken(process.pid) ?? undefined };

  it('removeWireGatewayStateIfOwnedBy leaves files another instance wrote', () => {
    writeInstanceStateFiles(replacement);
    const stoppedInstance: PidInfo = { ...replacement, startedAt: '2026-10-15T00:00:01.000Z' };
    expect(removeWireGatewayStateIfOwnedBy(stoppedInstance)).toBe(false);
    expect(removeWireGatewayStateIfOwnedBy(null)).toBe(false);
    expect(existsSync(paths.wireGatewayPid())).toBe(true);
    expect(existsSync(paths.wireGatewayRuntime())).toBe(true);

    expect(removeWireGatewayStateIfOwnedBy(replacement)).toBe(true);
    for (const file of [paths.wireGatewayPid(), paths.wireGatewayPort(), paths.wireGatewayRuntime()]) {
      expect(existsSync(file)).toBe(false);
    }
  });

  it('an uncaught error or rejection in the gateway process is logged and the gateway keeps running', async () => {
    // The daemon's stdio is ignored: without the handlers Bun would end it (exit 1) with no trace.
    const servicePath = fileURLToPath(new URL('../../src/services/wire-gateway/WireGatewayService.ts', import.meta.url));
    const child = Bun.spawn([process.execPath, '-e', `
      const { logUncaughtWireGatewayFailures } = await import(${JSON.stringify(servicePath)});
      logUncaughtWireGatewayFailures();
      setTimeout(() => { throw new Error('thrown from a timer'); }, 10);
      setTimeout(() => { Promise.reject(new Error('rejected promise')); }, 20);
      setTimeout(() => { process.stdout.write('alive\\n'); process.exit(0); }, 200);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe('alive\n');
  });

  it.skipIf(process.platform === 'win32')('stop keeps the state of a replacement that started while the old gateway drained', async () => {
    // The "old gateway": takes 500 ms to exit after SIGTERM, like a drain.
    const oldGateway = Bun.spawn([process.execPath, '-e', `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500));
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `], { stdout: 'pipe' });
    const reader = oldGateway.stdout.getReader();
    await reader.read();
    reader.releaseLock();

    writeInstanceStateFiles({
      pid: oldGateway.pid,
      port: 40001,
      startedAt: '2026-10-15T00:00:01.000Z',
      startToken: captureProcessStartToken(oldGateway.pid) ?? undefined,
    });

    const stopping = stopRunningWireGateway(5_000);
    // A replacement (worker autostart, another `wire start`) writes its state mid-drain.
    await new Promise(resolve => setTimeout(resolve, 150));
    writeInstanceStateFiles(replacement);

    await expect(stopping).resolves.toBe(true);
    await oldGateway.exited;
    expect(JSON.parse(readFileSync(paths.wireGatewayPid(), 'utf-8'))).toMatchObject({ pid: process.pid, port: 40002 });
    expect(readFileSync(paths.wireGatewayPort(), 'utf-8').trim()).toBe('40002');
    expect(existsSync(paths.wireGatewayRuntime())).toBe(true);
  });

  it('stop removes stale files of a gateway that is gone', async () => {
    writeInstanceStateFiles({ pid: 2 ** 22 + 12345, port: 40003, startedAt: '2026-10-15T00:00:03.000Z' });
    await expect(stopRunningWireGateway(1_000)).resolves.toBe(false);
    expect(existsSync(paths.wireGatewayPid())).toBe(false);
    expect(existsSync(paths.wireGatewayPort())).toBe(false);
  });
});

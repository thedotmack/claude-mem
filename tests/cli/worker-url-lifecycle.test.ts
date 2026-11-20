import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * CLAUDE_MEM_WORKER_URL end to end: the real worker-service entry point, a fake
 * worker at the URL, and a closed port at CLAUDE_MEM_WORKER_HOST:PORT, so a
 * command that ignores the URL or starts a local worker fails.
 */

const root = join(import.meta.dir, '..', '..');
const workerServiceEntry = join(root, 'src/services/worker-service.ts');

let dataDirectory: string;
let closedLocalPort: number;
let fakeWorker: ReturnType<typeof Bun.serve>;
let fakeWorkerUrl: string;
let fakeWorkerRequests: string[];

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no bound port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function clientEnvironment(workerUrl: string, autostart?: string): Record<string, string> {
  const { CLAUDE_MEM_WORKER_AUTOSTART: _ignored, ...inherited } = process.env;
  return {
    ...(inherited as Record<string, string>),
    CLAUDE_MEM_DATA_DIR: dataDirectory,
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_PORT: String(closedLocalPort),
    CLAUDE_MEM_WORKER_URL: workerUrl,
    CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_TELEMETRY: '0',
    ...(autostart === undefined ? {} : { CLAUDE_MEM_WORKER_AUTOSTART: autostart }),
  };
}

async function runWorkerService(args: string[], environment: Record<string, string>, stdin = '') {
  const child = Bun.spawn([process.execPath, workerServiceEntry, ...args], {
    cwd: root,
    env: environment,
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function localPortIsClosed(): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${closedLocalPort}/api/health`).catch(() => null);
  return response === null;
}

function expectNoLocalWorkerLaunched(): void {
  expect(existsSync(join(dataDirectory, 'worker.pid'))).toBe(false);
}

beforeEach(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'claude-mem-worker-url-'));
  closedLocalPort = await reserveClosedPort();
  fakeWorkerRequests = [];
  fakeWorker = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const { pathname } = new URL(request.url);
      fakeWorkerRequests.push(`${request.method} ${pathname}`);
      return Response.json({ status: 'ok', pid: 4242, version: 'remote-test', uptime: 1 });
    },
  });
  fakeWorkerUrl = `http://127.0.0.1:${fakeWorker.port}`;
});

afterEach(async () => {
  fakeWorker.stop(true);
  // Only reached by a regression: stop the local worker it launched.
  const pidFile = join(dataDirectory, 'worker.pid');
  if (existsSync(pidFile)) {
    try { process.kill(JSON.parse(readFileSync(pidFile, 'utf8')).pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('start with CLAUDE_MEM_WORKER_URL', () => {
  for (const autostart of [undefined, 'false', 'true']) {
    it(`reports the worker at the URL and launches nothing (autostart ${autostart ?? 'unset'})`, async () => {
      const { stdout } = await runWorkerService(['start'], clientEnvironment(fakeWorkerUrl, autostart));
      expect(JSON.parse(stdout.trim().split('\n').pop()!).status).toBe('ready');
      expect(fakeWorkerRequests).toContain('GET /api/health');
      expect(fakeWorkerRequests).toContain('GET /api/readiness');
      expect(await localPortIsClosed()).toBe(true);
      expectNoLocalWorkerLaunched();
    }, 30_000);
  }

  it('reports an error naming the URL when nothing answers there, and launches nothing', async () => {
    const silentUrl = `http://127.0.0.1:${await reserveClosedPort()}`;
    const { stdout } = await runWorkerService(['start'], clientEnvironment(silentUrl));
    const status = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(status.status).toBe('error');
    expect(status.message).toContain(silentUrl);
    expect(await localPortIsClosed()).toBe(true);
    expectNoLocalWorkerLaunched();
  }, 30_000);

  it('fails with the validation message on an invalid URL, and launches nothing', async () => {
    const { stdout } = await runWorkerService(['start'], clientEnvironment('http://worker.example:37777'));
    const status = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(status.status).toBe('error');
    expect(status.message).toContain('must use https');
    expect(await localPortIsClosed()).toBe(true);
    expectNoLocalWorkerLaunched();
  }, 30_000);
});

describe('other lifecycle commands with CLAUDE_MEM_WORKER_URL', () => {
  it('stop never asks the worker at the URL to shut down', async () => {
    const { exitCode } = await runWorkerService(['stop'], clientEnvironment(fakeWorkerUrl));
    expect(exitCode).toBe(0);
    expect(fakeWorkerRequests.filter(request => request.includes('/api/admin/'))).toEqual([]);
  }, 30_000);

  it('restart refuses, leaves the worker at the URL alone, and launches nothing', async () => {
    const { exitCode, stderr } = await runWorkerService(['restart'], clientEnvironment(fakeWorkerUrl));
    expect(exitCode).toBe(1);
    expect(stderr).toContain(fakeWorkerUrl);
    expect(fakeWorkerRequests).toEqual([]);
    expect(await localPortIsClosed()).toBe(true);
    expectNoLocalWorkerLaunched();
  }, 30_000);

  it('status reads the worker at the URL', async () => {
    const { stdout } = await runWorkerService(['status'], clientEnvironment(fakeWorkerUrl));
    expect(stdout).toContain('Worker is running');
    expect(stdout).toContain(`URL: ${fakeWorkerUrl}`);
    expect(fakeWorkerRequests).toContain('GET /api/health');
  }, 30_000);

  it('status says the URL is unreachable when nothing answers there', async () => {
    const silentUrl = `http://127.0.0.1:${await reserveClosedPort()}`;
    const { stdout } = await runWorkerService(['status'], clientEnvironment(silentUrl));
    expect(stdout).toContain(`Worker is not reachable at ${silentUrl}`);
  }, 30_000);

  it('status exits nonzero with the validation message on an invalid URL', async () => {
    const { exitCode, stderr } = await runWorkerService(['status'], clientEnvironment('ftp://worker.example'));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must use http or https');
  }, 30_000);
});

describe('a hook with an invalid CLAUDE_MEM_WORKER_URL', () => {
  it('prints the validation message, exits 0, and launches nothing', async () => {
    const hookInput = JSON.stringify({
      session_id: 'worker-url-invalid', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'hello',
    });
    const { exitCode, stderr } = await runWorkerService(
      ['hook', 'claude-code', 'session-init'],
      clientEnvironment('http://worker.example:37777'),
      hookInput,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain('claude-mem: hook error, continuing without memory: CLAUDE_MEM_WORKER_URL must use https');
    expect(await localPortIsClosed()).toBe(true);
    expectNoLocalWorkerLaunched();
  }, 30_000);
});

describe('the plain HTTP warning on remote upload', () => {
  async function warningsFromUpload(host: string, workerUrl: string, transport: string): Promise<string[]> {
    const source = `
      const { spyOn } = await import('bun:test');
      const { logger } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/utils/logger.ts')).href)});
      const warn = spyOn(logger, 'warn');
      const { uploadRemoteHookSpool } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/cli/spool-hook-event.ts')).href)});
      await uploadRemoteHookSpool();
      console.log(JSON.stringify(warn.mock.calls.map(call => call[1])));
    `;
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: root,
      env: {
        ...clientEnvironment(workerUrl, 'false'),
        CLAUDE_MEM_WORKER_HOST: host,
        CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: transport,
        CLAUDE_MEM_WORKER_INGEST_TOKEN: 'test-ingest-token',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`upload exited ${exitCode}: ${stderr}`);
    return JSON.parse(stdout.trim().split('\n').pop()!);
  }

  const plainHttpWarning = expect.stringContaining('over plain HTTP');

  it('fires for a non-loopback host with no URL', async () => {
    expect(await warningsFromUpload('worker.internal', '', 'auto')).toContainEqual(plainHttpWarning);
  }, 30_000);

  it('stays quiet when a URL is set', async () => {
    expect(await warningsFromUpload('worker.internal', 'https://worker.example', 'auto')).not.toContainEqual(plainHttpWarning);
  }, 30_000);

  it('stays quiet for a loopback port forward over HTTP', async () => {
    expect(await warningsFromUpload('127.0.0.1', '', 'http')).not.toContainEqual(plainHttpWarning);
  }, 30_000);
});

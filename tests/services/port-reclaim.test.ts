import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import net from 'net';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the data dir at a scratch directory BEFORE anything under src/ is
// imported — paths.ts resolves DATA_DIR at module load, and the registry
// reader derives supervisor.json from it.
const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-reclaim-'));
process.env.CLAUDE_MEM_DATA_DIR = dataDir;

const { reclaimWorkerPort } = await import('../../src/services/infrastructure/PortReclaim.js');
const { captureProcessStartToken, isPidAlive } = await import('../../src/supervisor/process-registry.js');

/**
 * These tests use REAL processes and REAL sockets on purpose.
 *
 * The claim this module has to earn is "it never kills something it cannot
 * prove is ours". That is a claim about behaviour against live processes, and
 * a mocked kill path cannot demonstrate it — the review that blocked #3405
 * proved the opposite behaviour by running the code against a real foreign
 * listener, so the rebuttal has to be made on the same terms.
 */

const spawned: ChildProcess[] = [];
const servers: Array<net.Server | http.Server> = [];

/** A process that holds `port` open and answers nothing. Stands in for the
 *  orphaned chroma child that pins the socket after the worker dies (#3450). */
function spawnPortHolder(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`],
    { stdio: 'ignore' }
  );
  spawned.push(child);
  return new Promise(resolve => setTimeout(() => resolve(child), 400));
}

function listenPlain(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    servers.push(server);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** A listener that DOES answer /api/health — i.e. looks like a live worker. */
function listenHealthy(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    servers.push(server);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function writeRegistry(records: Record<string, unknown>): void {
  writeFileSync(join(dataDir, 'supervisor.json'), JSON.stringify({ processes: records }), 'utf-8');
}

function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

let nextPort = 41200;
const takePort = (): number => nextPort++;

beforeAll(() => {
  writeRegistry({});
});

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  writeRegistry({});
});

describe('reclaimWorkerPort — rung 3b: refuses to touch what it cannot prove is ours', () => {
  it('leaves an unrelated local listener running and reports unprovable', async () => {
    // This is the exact scenario the security review reproduced against the
    // previous implementation, which identified the port owner and killed its
    // process tree. The assertion is inverted: the foreign process survives.
    const port = takePort();
    const holder = await spawnPortHolder(port);
    expect(isPidAlive(holder.pid!)).toBe(true);

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('unprovable');
    expect(isPidAlive(holder.pid!)).toBe(true);
    expect(await isListening(port)).toBe(true);
  });

  it('refuses when the pid file names a dead owner and the registry vouches for nothing', async () => {
    const port = takePort();
    await listenPlain(port);

    // A pid file that survived its worker — #3450 observed exactly this, with
    // the startToken still present and the pid long gone.
    const outcome = await reclaimWorkerPort(port, {
      pid: 999_999_21,
      port,
      startedAt: new Date().toISOString(),
      startToken: 'token-of-a-process-that-no-longer-exists',
    });

    expect(outcome.kind).toBe('unprovable');
    expect(await isListening(port)).toBe(true);
  });

  it('refuses a registry record that has no start token', async () => {
    const port = takePort();
    const holder = await spawnPortHolder(port);

    // Tokenless records are what an older claude-mem persisted. They name a
    // pid and nothing else, so they cannot establish identity.
    writeRegistry({
      'chroma-mcp': { pid: holder.pid, type: 'chroma-mcp', startedAt: new Date().toISOString() },
    });

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('unprovable');
    expect(isPidAlive(holder.pid!)).toBe(true);
  });

  it('refuses a registry record whose start token does not match the live pid', async () => {
    const port = takePort();
    const holder = await spawnPortHolder(port);

    // Same pid, wrong token: the pid was recycled onto a different process.
    writeRegistry({
      'chroma-mcp': {
        pid: holder.pid,
        type: 'chroma-mcp',
        startedAt: new Date().toISOString(),
        startToken: 'not-the-token-this-pid-actually-has',
      },
    });

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('unprovable');
    expect(isPidAlive(holder.pid!)).toBe(true);
  });
});

describe('reclaimWorkerPort — rung 3a: reaps the identity-verified orphan holding the socket', () => {
  it('kills a registered child whose start token matches, and recovers the port', async () => {
    // The #3073/#3450 shape: the worker is gone, but a child it registered is
    // still alive and still holding the listening socket.
    const port = takePort();
    const holder = await spawnPortHolder(port);
    const token = captureProcessStartToken(holder.pid!);
    expect(token).not.toBeNull();

    writeRegistry({
      'chroma-mcp': {
        pid: holder.pid,
        type: 'chroma-mcp',
        startedAt: new Date().toISOString(),
        startToken: token,
      },
    });

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('reclaimed');
    if (outcome.kind === 'reclaimed') expect(outcome.via).toBe('registered-children');
    expect(isPidAlive(holder.pid!)).toBe(false);
  });

  it('never reaps the record for the worker itself', async () => {
    const port = takePort();
    const holder = await spawnPortHolder(port);
    const token = captureProcessStartToken(holder.pid!);

    // Registered as the worker, not a child. Rung 1 owns the worker, via the
    // pid file; rung 3a must not take a second, unproven route to it.
    writeRegistry({
      worker: { pid: holder.pid, type: 'worker', startedAt: new Date().toISOString(), startToken: token },
    });

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('unprovable');
    expect(isPidAlive(holder.pid!)).toBe(true);
  });
});

describe('reclaimWorkerPort — rung 2: never reclaims an owner that is merely initializing', () => {
  it('reports owner-initializing when the verified owner still answers health', async () => {
    const port = takePort();
    await listenHealthy(port);

    // The pid file names THIS process, which is provably alive with a matching
    // token — a stand-in for a verified worker mid-cold-boot (readiness false,
    // health fine). Passing a different currentPid keeps the self-reclaim guard
    // out of the way so rung 2 itself is what is under test.
    const outcome = await reclaimWorkerPort(
      port,
      {
        pid: process.pid,
        port,
        startedAt: new Date().toISOString(),
        startToken: captureProcessStartToken(process.pid) ?? undefined,
      },
      process.pid + 1
    );

    expect(outcome.kind).toBe('owner-initializing');
  });
});

describe('reclaimWorkerPort — rung 1: terminates a verified wedged owner', () => {
  it('kills the pid-file owner when it holds the port but answers nothing', async () => {
    const port = takePort();
    const holder = await spawnPortHolder(port);
    const token = captureProcessStartToken(holder.pid!);
    expect(token).not.toBeNull();

    const outcome = await reclaimWorkerPort(port, {
      pid: holder.pid!,
      port,
      startedAt: new Date().toISOString(),
      startToken: token ?? undefined,
    });

    expect(outcome.kind).toBe('reclaimed');
    if (outcome.kind === 'reclaimed') expect(outcome.via).toBe('verified-owner');
    expect(isPidAlive(holder.pid!)).toBe(false);
    // Generous: this path really does spend seconds — a SIGTERM grace window
    // plus the port-recovery confirmation — and that is the intended behaviour,
    // not something to tune down to fit a default test timeout.
  }, 30_000);

  it('refuses to reclaim a port whose pid file names the current process', async () => {
    const port = takePort();
    await listenPlain(port);

    const outcome = await reclaimWorkerPort(
      port,
      { pid: process.pid, port, startedAt: new Date().toISOString() },
      process.pid
    );

    expect(outcome.kind).toBe('unprovable');
  });
});

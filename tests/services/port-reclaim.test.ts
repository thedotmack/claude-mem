import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import net from 'net';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { paths } from '../../src/shared/paths.js';
import { reclaimWorkerPort } from '../../src/services/infrastructure/PortReclaim.js';
import { captureProcessStartToken, isPidAlive } from '../../src/supervisor/process-registry.js';

// The registry file MUST be the one the code under test reads. paths.ts
// resolves DATA_DIR once at module load, and under `bun test` that module is
// shared across every test file in the run, so setting CLAUDE_MEM_DATA_DIR
// here would only take effect when this file happens to load paths.ts first
// (it did in isolation, and silently did not in the full suite: the reaper
// then read an empty registry and every rung-3a case degraded to
// 'unprovable'). tests/preload.ts already points CLAUDE_MEM_DATA_DIR at a
// per-run scratch directory, so resolving through `paths` is both correct
// and isolated from the user's real ~/.claude-mem.
const registryPath = paths.supervisorRegistry();

/**
 * These tests use REAL processes and REAL sockets on purpose.
 *
 * The claim this module has to earn is "it never kills something it cannot
 * prove is ours". That is a claim about behaviour against live processes, and
 * a mocked kill path cannot demonstrate it: the review that blocked #3405
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

/** A listener that DOES answer /api/health, i.e. looks like a live worker. */
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
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ processes: records }), 'utf-8');
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

/** A process that does nothing but stay alive; stands in for a live SDK child. */
function spawnIdleChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  spawned.push(child);
  return new Promise(resolve => setTimeout(() => resolve(child), 300));
}

/**
 * Has `child` exited? Resolves as soon as the runtime reaps it, or false after
 * `timeoutMs`. Used where the assertion is "it was killed": isPidAlive alone
 * is racy for our own children, because kill(pid, 0) still succeeds on a
 * zombie the event loop has not yet reaped.
 */
function exited(child: ChildProcess, timeoutMs = 3_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Owner linkage naming a worker generation that is provably gone: a pid that
 * cannot be alive and a token that could never match it. This is what a
 * child record looks like after the worker that spawned it crashed.
 */
const DEAD_OWNER = { ownerPid: 999_999_21, ownerStartToken: 'token-of-a-worker-that-crashed' };

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

describe('reclaimWorkerPort rung 3b: refuses to touch what it cannot prove is ours', () => {
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

    // A pid file that survived its worker. #3450 observed exactly this, with
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

describe('reclaimWorkerPort rung 3a: reaps the identity-verified orphan holding the socket', () => {
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
        ...DEAD_OWNER,
      },
    });

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('reclaimed');
    if (outcome.kind === 'reclaimed') expect(outcome.via).toBe('registered-children');
    expect(isPidAlive(holder.pid!)).toBe(false);
  });

  it('kills a registered child whose owner pid was recycled onto a different process', async () => {
    // The owner pid is alive (it is this test process) but its token is not
    // the one the record carries: the worker that spawned the child is gone
    // and its pid has been reused. The child is an orphan.
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
        ownerPid: process.pid,
        ownerStartToken: 'not-the-token-this-pid-actually-has',
      },
    });

    const outcome = await reclaimWorkerPort(port, null);

    expect(outcome.kind).toBe('reclaimed');
    expect(isPidAlive(holder.pid!)).toBe(false);
  });

  it('leaves a verified child alone when its owner worker is still alive', async () => {
    // The scenario review reproduced: a live, identity-verified SDK record
    // that belongs to the CURRENT worker sits in the same registry file as
    // the dead worker's orphans. Reclaiming the port must not kill it. Here
    // the owner is this test process, provably alive with a matching token.
    const port = takePort();
    const holder = await spawnPortHolder(port);
    const sdkChild = await spawnIdleChild();
    const holderToken = captureProcessStartToken(holder.pid!);
    const sdkToken = captureProcessStartToken(sdkChild.pid!);
    const liveOwnerToken = captureProcessStartToken(process.pid);
    expect(holderToken).not.toBeNull();
    expect(sdkToken).not.toBeNull();
    expect(liveOwnerToken).not.toBeNull();

    writeRegistry({
      'chroma-mcp': {
        pid: holder.pid,
        type: 'chroma-mcp',
        startedAt: new Date().toISOString(),
        startToken: holderToken,
        ...DEAD_OWNER,
      },
      'sdk:42:1': {
        pid: sdkChild.pid,
        type: 'sdk',
        sessionId: 42,
        startedAt: new Date().toISOString(),
        startToken: sdkToken,
        ownerPid: process.pid,
        ownerStartToken: liveOwnerToken,
      },
    });

    const outcome = await reclaimWorkerPort(port, null);

    // The dead worker's orphan is reaped and the port recovers...
    expect(outcome.kind).toBe('reclaimed');
    expect(isPidAlive(holder.pid!)).toBe(false);
    // ...but the live worker's SDK child is untouched.
    expect(isPidAlive(sdkChild.pid!)).toBe(true);
  });

  it('leaves a verified child alone when its record has no owner linkage', async () => {
    // A record persisted by an older claude-mem: identity-verifiable, but not
    // tied to any worker generation. It cannot be proven orphaned, so it is
    // not signalled and the caller fails over.
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

    expect(outcome.kind).toBe('unprovable');
    expect(isPidAlive(holder.pid!)).toBe(true);
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

describe('reclaimWorkerPort rung 2: never reclaims an owner that is merely initializing', () => {
  it('reports owner-initializing when the verified owner still answers health', async () => {
    const port = takePort();
    await listenHealthy(port);

    // The pid file names THIS process, which is provably alive with a matching
    // token, a stand-in for a verified worker mid-cold-boot (readiness false,
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

describe('reclaimWorkerPort rung 1: terminates a verified wedged owner', () => {
  it('kills the pid-file owner when it holds the port but answers nothing', async () => {
    const port = takePort();
    const holder = await spawnPortHolder(port);
    const token = captureProcessStartToken(holder.pid!);
    expect(token).not.toBeNull();

    // Two registered children: one spawned by the wedged owner (reaped with
    // it, so it cannot re-pin the socket) and one owned by a live worker
    // (this test process), which rung 1 must leave alone.
    const ownersChild = await spawnIdleChild();
    const liveWorkersChild = await spawnIdleChild();
    writeRegistry({
      'sdk:1:a': {
        pid: ownersChild.pid,
        type: 'sdk',
        startedAt: new Date().toISOString(),
        startToken: captureProcessStartToken(ownersChild.pid!),
        ownerPid: holder.pid,
        ownerStartToken: token,
      },
      'sdk:2:b': {
        pid: liveWorkersChild.pid,
        type: 'sdk',
        startedAt: new Date().toISOString(),
        startToken: captureProcessStartToken(liveWorkersChild.pid!),
        ownerPid: process.pid,
        ownerStartToken: captureProcessStartToken(process.pid),
      },
    });

    const outcome = await reclaimWorkerPort(port, {
      pid: holder.pid!,
      port,
      startedAt: new Date().toISOString(),
      startToken: token ?? undefined,
    });

    expect(outcome.kind).toBe('reclaimed');
    if (outcome.kind === 'reclaimed') expect(outcome.via).toBe('verified-owner');
    expect(isPidAlive(holder.pid!)).toBe(false);
    expect(await exited(ownersChild)).toBe(true);
    expect(isPidAlive(liveWorkersChild.pid!)).toBe(true);
    // Generous: this path really does spend seconds (a SIGTERM grace
    // window plus the port-recovery confirmation), and that is intended behaviour,
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

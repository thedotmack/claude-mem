import { describe, expect, it } from 'bun:test';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import net from 'net';
import { buildNoOpResult } from '../../src/cli/hook-command.js';
import { isPortInUse, waitForHealth, waitForPortFree } from '../../src/services/infrastructure/index.js';
import { runShutdownSequence } from '../../src/services/worker-shutdown.js';

const reproduction = readFileSync(new URL('../fixtures/claude-mem-PR-TARGET-3204-REPRO.md', import.meta.url), 'utf8');

describe('issue #3204 Windows worker port recovery', () => {
  it('keeps a silent listener occupied, bounds health, and forwards dead hooks into the worker-unavailable no-op path', async () => {
    expect(reproduction).toContain('LISTENING');
    expect(reproduction).toContain('pid=0');
    expect(reproduction).toContain('Is port 37779 in use?');
    expect(reproduction).toContain('60–120s');

    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener did not expose a port');

    try {
      expect(await isPortInUse(address.port)).toBe(true);
      const start = Date.now();
      expect(await waitForHealth(address.port, 200)).toBe(false);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(await waitForPortFree(address.port, 200)).toBe(false);

      const child = spawn(process.execPath, ['run', 'src/services/worker-service.ts', 'hook', 'raw', 'context'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAUDE_MEM_WORKER_PORT: String(address.port),
          CLAUDE_MEM_HEALTH_TIMEOUT_MS: '500',
          CLAUDE_MEM_API_TIMEOUT_MS: '500',
          CLAUDE_MEM_DATA_DIR: `${process.env.TEMP ?? process.env.TMP ?? '/tmp'}/claude-mem-3204-${process.pid}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(JSON.stringify({ cwd: process.cwd() }));
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('hook command exceeded 10s')); }, 10000);
        child.on('error', reject);
        child.on('close', (code) => { clearTimeout(timer); resolve(code ?? -1); });
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual(buildNoOpResult('context'));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 15000);

  it('restart handoff blocks PID cleanup and successor spawn for an occupied port', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener did not expose a port');
    const calls: string[] = [];

    try {
      await runShutdownSequence({
        reason: 'restart',
        isShuttingDown: () => false,
        markShuttingDown: () => undefined,
        beforeGracefulShutdown: async () => undefined,
        performGracefulShutdown: async () => { calls.push('graceful'); },
        gracefulDeadlineMs: 1000,
        restartHandoff: {
          port: address.port,
          portFreeTimeoutMs: 200,
          resolveSuccessorScript: () => 'worker-service.cjs',
          waitForPortFree: async (port, timeoutMs) => {
            const free = await waitForPortFree(port, timeoutMs);
            calls.push(`port-free:${free}`);
            return free;
          },
          removePidFile: () => calls.push('remove-pid'),
          spawnDaemon: () => { calls.push('spawn'); return 1; },
        },
      });

      expect(await isPortInUse(address.port)).toBe(true);
      expect(calls).toEqual(['graceful', 'port-free:false']);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('restart handoff preserves ordered successor spawn for a genuinely free port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener did not expose a port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const calls: string[] = [];

    await runShutdownSequence({
      reason: 'restart',
      isShuttingDown: () => false,
      markShuttingDown: () => undefined,
      beforeGracefulShutdown: async () => undefined,
      performGracefulShutdown: async () => { calls.push('graceful'); },
      gracefulDeadlineMs: 1000,
      restartHandoff: {
        port,
        portFreeTimeoutMs: 1000,
        resolveSuccessorScript: () => 'worker-service.cjs',
        waitForPortFree: async (handoffPort, timeoutMs) => {
          const free = await waitForPortFree(handoffPort, timeoutMs);
          calls.push('port-free');
          return free;
        },
        removePidFile: () => calls.push('remove-pid'),
        spawnDaemon: () => { calls.push('spawn'); return 1; },
      },
    });

    expect(calls).toEqual(['graceful', 'port-free', 'remove-pid', 'spawn']);
  });
});

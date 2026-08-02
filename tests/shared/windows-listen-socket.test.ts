import { describe, it, expect } from 'bun:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWindowsListenSocketInherit } from '../../src/shared/windows-listen-socket.js';

describe('windows-listen-socket — HANDLE_FLAG_INHERIT clear (#3300)', () => {
  it('is a no-op on non-Windows platforms', async () => {
    if (process.platform === 'win32') return;

    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      expect(clearWindowsListenSocketInherit(server)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('clears inherit on the listen socket under Bun on Windows', async () => {
    if (process.platform !== 'win32') return;

    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      expect(clearWindowsListenSocketInherit(server)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('prevents a Windows child from keeping the port after the parent exits', async () => {
    if (process.platform !== 'win32') return;

    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-listen-inherit-'));
    const markerPath = join(tempDir, 'marker.json');
    const scriptPath = join(tempDir, 'parent.mjs');

    // Subprocess: listen, clear inherit, spawn a long-lived child, hard-exit.
    // After parent death the port must be free even while the child lives.
    writeFileSync(
      scriptPath,
      `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { clearWindowsListenSocketInherit } from ${JSON.stringify(
        join(process.cwd(), 'src/shared/windows-listen-socket.ts').replace(/\\/g, '/')
      )};

const marker = ${JSON.stringify(markerPath.replace(/\\/g, '/'))};
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const cleared = clearWindowsListenSocketInherit(server);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  writeFileSync(marker, JSON.stringify({
    parent: process.pid,
    child: child.pid,
    port,
    cleared,
  }));
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200);
});
`
    );

    try {
      const parent = spawn(process.execPath, [scriptPath], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise<void>((resolve) => parent.once('exit', () => resolve()));
      // Parent may die via SIGKILL before emitting exit on some hosts; poll marker.
      const deadline = Date.now() + 5000;
      while (!existsEventually(markerPath) && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      expect(existsEventually(markerPath)).toBe(true);

      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
        parent: number;
        child: number;
        port: number;
        cleared: boolean;
      };
      expect(marker.cleared).toBe(true);
      expect(marker.port).toBeGreaterThan(0);

      await Bun.sleep(400);

      // Child still alive, but port must not stay LISTENING under the dead parent.
      try {
        process.kill(marker.child, 0);
      } catch {
        throw new Error(`expected long-lived child ${marker.child} to still be alive`);
      }

      const portFree = await canBindPort(marker.port);
      expect(portFree).toBe(true);

      try {
        process.kill(marker.child, 'SIGKILL');
      } catch {
        // already gone
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function existsEventually(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

async function canBindPort(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNpmStrict } from '../src/npx-cli/install/npm-install-helper.js';

it.skipIf(process.platform === 'win32')('terminates a timed-out installer that ignores SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-npm-timeout-'));
  const pidFile = join(root, 'child.pid');
  const oldPath = process.env.PATH;
  const oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  const cleanup = () => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} };
  // Independent cleanup guarantees the failing baseline never leaves an orphan.
  const watchdog = setTimeout(cleanup, 5000);
  try {
    writeFileSync(join(root, 'npm'), `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nexec /bin/sleep 60\n`, { mode: 0o755 });
    process.env.PATH = root + ':' + oldPath;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '1000';
    const start = performance.now();
    const result = await runNpmStrict(root, ['fixture']);
    expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(performance.now() - start).toBeLessThan(4000);
  } finally {
    clearTimeout(watchdog); cleanup();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(root, { recursive: true, force: true });
  }
}, 7000);

it.skipIf(process.platform === 'win32')('reports a timeout even if the child handles SIGTERM by exiting zero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-npm-timeout-zero-'));
  const pidFile = join(root, 'child.pid');
  const oldPath = process.env.PATH;
  const oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  const cleanup = () => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} };
  const watchdog = setTimeout(cleanup, 5000);
  try {
    writeFileSync(join(root, 'npm'), `#!${process.execPath}\nconst fs=require('fs'); process.on('SIGTERM',()=>process.exit(0)); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},100);\n`, { mode: 0o755 });
    process.env.PATH = root + ':' + oldPath;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '1000';
    const result = await runNpmStrict(root, ['fixture']);
    expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(124);
  } finally {
    clearTimeout(watchdog); cleanup();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(root, { recursive: true, force: true });
  }
}, 7000);

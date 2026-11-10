import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

function packet(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type), length, payload]);
}

test('successful server jobs commands close their pools and let the CLI exit', { timeout: 15_000 }, async () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const scratchRoot = join(repoRoot, '.scratch', 'test-runs');
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'server-jobs-pool-'));
  const sockets = new Set<Socket>();
  let connections = 0, terminations = 0;
  const queries: string[] = [];
  const server = createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let startup = true;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (startup) {
          if (buffer.length < 4) return;
          const length = buffer.readUInt32BE(0);
          if (buffer.length < length) return;
          buffer = buffer.subarray(length);
          startup = false;
          socket.write(Buffer.concat([packet('R', Buffer.alloc(4)), packet('Z', Buffer.from('I'))]));
          continue;
        }
        if (buffer.length < 5) return;
        const length = buffer.readUInt32BE(1);
        if (buffer.length < length + 1) return;
        const type = String.fromCharCode(buffer[0]);
        const payload = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        if (type === 'Q') {
          queries.push(payload.toString('utf8').replace(/\0$/, ''));
          socket.write(Buffer.concat([packet('C', Buffer.from('SELECT 0\0')), packet('Z', Buffer.from('I'))]));
        } else if (type === 'X') {
          terminations++;
          socket.end();
        }
      }
    });
  });
  let child: ReturnType<typeof spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let startupWatchdog: ReturnType<typeof setTimeout> | undefined;
  let forcedExit = false, closed = false;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const runner = join(directory, 'jobs.cjs');
    await build({
      stdin: {
        contents: `
          import { runServerJobsCommand, __setServerJobsTestSeams } from ${JSON.stringify(join(repoRoot, 'src/npx-cli/commands/server-jobs.ts'))};
          __setServerJobsTestSeams({ collectBullmqCounts: async () => ({}) });
          (async () => {
            await runServerJobsCommand(['status']);
            await runServerJobsCommand(['status']);
            console.log('__JOBS_COMPLETE__');
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
        resolveDir: repoRoot, loader: 'ts',
      },
      bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: runner,
      logLevel: 'silent',
    });
    child = spawn(process.execPath, [runner], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: directory,
        CLAUDE_MEM_SERVER_DATABASE_URL: `postgres://fixture:fixture@127.0.0.1:${address.port}/fixture`,
        CLAUDE_MEM_SERVER_ADMIN: '1',
        CLAUDE_MEM_POSTGRES_SSL: 'disable',
        CLAUDE_MEM_POSTGRES_IDLE_TIMEOUT_MS: '30000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    const stop = () => { forcedExit = true; if (!closed) child!.kill('SIGKILL'); };
    startupWatchdog = setTimeout(stop, 8_000);
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      if (!watchdog && output.includes('__JOBS_COMPLETE__')) {
        clearTimeout(startupWatchdog);
        watchdog = setTimeout(stop, 2_000);
      }
    });
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', code => { closed = true; resolve(code); });
    });
    // Drain the fixture's socket callbacks before checking Terminate packets.
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.match(output, /__JOBS_COMPLETE__/, errors);
    assert.equal(forcedExit, false, 'Both commands returned, but their idle PostgreSQL pool kept the CLI alive.');
    assert.equal(exitCode, 0, errors);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => query.includes('observation_generation_jobs')));
    assert.equal(connections, 2, 'Each command owns a fresh pool; a closed shared pool must not be reused.');
    assert.equal(terminations, 2);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (startupWatchdog) clearTimeout(startupWatchdog);
    if (child && !closed) child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

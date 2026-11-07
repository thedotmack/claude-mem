import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function seedContextDatabase(path: string): void {
  const store = new SessionStore(path);
  try {
    const session = store.createSDKSession('read-content', 'app', 'context read');
    store.ensureMemorySessionIdRegistered(session, 'read-memory');
    store.storeObservation('read-memory', 'app', {
      type: 'discovery', title: 'KEEP_CONTEXT_RECORD', subtitle: null,
      facts: [], narrative: 'Read-only context remains available.', concepts: ['how-it-works'],
      files_read: [], files_modified: [],
    }, 1);
  } finally {
    store.close();
  }
}

export async function assertContextReadResponsive(options: { entry?: string; cwd?: string; executable?: boolean } = {}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-reader-http-'));
  const databasePath = join(directory, 'claude-mem.db');
  const seeded = Bun.spawnSync([process.execPath, '-e', `
    import { SessionStore } from './src/services/sqlite/SessionStore.ts';
    (${seedContextDatabase.toString()})(${JSON.stringify(databasePath)});
  `], { cwd: process.cwd(), env: { ...process.env, CLAUDE_MEM_TELEMETRY_ENABLED: 'false' } });
  if (seeded.exitCode !== 0) throw new Error(new TextDecoder().decode(seeded.stderr));
  const lock = new Database(databasePath);
  lock.exec('PRAGMA journal_mode=DELETE');
  const signals: { port?: (port: number) => void; started?: () => void; rejectReady?: (error: Error) => void; rejectStarted?: (error: Error) => void } = {};
  const ready = new Promise<number>((resolve, reject) => { signals.port = resolve; signals.rejectReady = reject; });
  const started = new Promise<void>((resolve, reject) => { signals.started = resolve; signals.rejectStarted = reject; });
  void started.catch(() => undefined);
  const fail = (error: Error) => { signals.rejectReady?.(error); signals.rejectStarted?.(error); };
  const entry = options.entry ?? process.env.CONTEXT_READ_HTTP_FIXTURE ?? join(process.cwd(), 'tests/fixtures/context-read-http-server.ts');
  const child = spawn(options.executable ? entry : process.execPath, options.executable ? [] : [entry], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: directory,
      CLAUDE_CONFIG_DIR: directory,
      CLAUDE_MEM_MODES_DIR: join(process.cwd(), 'plugin/modes'),
      CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
      // Bun 1.3.9 inlines `process.env.X` reads into the runtime transpiler cache
      // for worker-thread files (>= 50 KB, keyed by content). The reader bundle is
      // byte-identical between runs, so its worker would read the data dir of the
      // first run that cached it and render no context. Disable the cache here.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => {
    output.stdout += chunk.toString();
    const match = /READER_HTTP_PORT=(\d+)/.exec(output.stdout);
    if (match) signals.port?.(Number(match[1]));
    if (output.stdout.includes('CONTEXT_READ_STARTED')) signals.started?.();
  });
  child.stderr.on('data', chunk => { output.stderr += chunk.toString(); });
  child.once('error', fail);
  const exited = new Promise<void>(resolve => child.once('exit', code => {
    fail(new Error(`HTTP fixture exited ${code}: ${output.stderr}`));
    resolve();
  }));
  const startupTimeout = setTimeout(() => fail(new Error(`HTTP fixture did not start: ${output.stderr}`)), 10_000);
  const lockState = { held: false };
  const unlock = () => {
    if (!lockState.held) return;
    lock.exec('ROLLBACK');
    lockState.held = false;
  };
  const unlockTimer = { value: undefined as ReturnType<typeof setTimeout> | undefined };
  try {
    const port = await ready;
    clearTimeout(startupTimeout);
    lock.exec('BEGIN EXCLUSIVE');
    lockState.held = true;
    unlockTimer.value = setTimeout(unlock, 2_500);
    const contextRequest = fetch(`http://127.0.0.1:${port}/context`, { signal: AbortSignal.timeout(10_000) });
    void contextRequest.catch(fail);
    await started;
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
    expect(health.ok).toBe(true);
    expect(await health.json()).toEqual({ status: 'ok' });
    const context = await contextRequest;
    const contextBody = await context.text();
    if (!context.ok) throw new Error(`Context read failed with ${context.status}: ${contextBody}\nfixture stderr: ${output.stderr}`);
    expect(contextBody).toContain('KEEP_CONTEXT_RECORD');
  } finally {
    clearTimeout(startupTimeout);
    if (unlockTimer.value) clearTimeout(unlockTimer.value);
    unlock();
    lock.close();
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}

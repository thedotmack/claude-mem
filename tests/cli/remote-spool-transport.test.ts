import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { HookSpoolRoutes } from '../../src/services/worker/http/routes/HookSpoolRoutes.js';
import { HookSpool, type HookSpoolConsumedMarkers } from '../../src/shared/hook-spool.js';
import { REMOTE_SPOOL_TIMEOUT_MS } from '../../src/shared/hook-spool-remote.js';

const root = join(import.meta.dir, '..', '..');
const moduleUrl = (path: string) => pathToFileURL(join(root, path)).href;
let directory: string;
let spool: HookSpool;
let server: Server;
let port: number;
let mode: 'normal' | 'legacy' | 'wrong-ack' | 'stalled-body';
let requestPaths: string[];
const markers: HookSpoolConsumedMarkers = {
  isConsumed: () => false, markConsumed() {}, clearConsumed() {}, pruneConsumedBefore() {},
};

async function listen(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    requestPaths.push(req.path);
    if (mode === 'legacy') { res.status(202).json({ status: 'draining' }); return; }
    if (mode === 'wrong-ack') {
      res.status(202).json({ protocolVersion: 1, status: 'accepted', receipt: 'another-event' }); return;
    }
    if (mode === 'stalled-body') {
      res.setHeader('Content-Type', 'application/json');
      res.write('{"protocolVersion":1');
      return;
    }
    next();
  });
  new HookSpoolRoutes(spool, () => markers, () => {}, () => 'test-ingest-token').setupRoutes(app);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('no bound port');
  port = bound.port;
}

async function close(): Promise<void> {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'claude-mem-remote-client-'));
  spool = new HookSpool(join(directory, 'worker-spool'));
  mode = 'normal';
  requestPaths = [];
  await listen();
});
afterEach(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function child(action: 'observation' | 'stop' | 'flush' | 'poison', token: string = 'test-ingest-token') {
  const source = `
    const { uploadRemoteHookSpool } = await import(${JSON.stringify(moduleUrl('src/cli/spool-hook-event.ts'))});
    const { HookSpool } = await import(${JSON.stringify(moduleUrl('src/shared/hook-spool.ts'))});
    const common = { contentSessionId: 'remote-client', platformSource: 'codex', cwd: '/project' };
    const started = performance.now();
    if (${JSON.stringify(action)} === 'poison') {
      new HookSpool().enqueue('observation', { ...common, toolName: 'exec_command', toolInput: {}, toolResponse: 'rejected capture', toolUseId: 'x'.repeat(2049) });
    }
    if (${JSON.stringify(action)} === 'observation' || ${JSON.stringify(action)} === 'poison') {
      new HookSpool().enqueue('observation', { ...common, toolName: 'exec_command', toolInput: { cmd: 'read fixture' }, toolResponse: 'client routing rule', toolUseId: 'client-tool-1' });
    } else if (${JSON.stringify(action)} === 'stop') {
      new HookSpool().enqueue('advisor_calls', { ...common, calls: [{ toolUseId: 'advisor-1', advice: 'keep the queued event', occurredAtEpoch: Date.now() }] });
      new HookSpool().enqueue('summarize', { ...common, lastAssistantMessage: 'done' });
      new HookSpool().enqueue('session_end', common);
    }
    await uploadRemoteHookSpool();
    console.log(JSON.stringify({ elapsedMs: performance.now() - started, entries: new HookSpool().entries() }));
  `;
  const proc = Bun.spawn([process.execPath, '-e', source], {
    cwd: root,
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'client'),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_AUTOSTART: 'false', CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: 'http',
      CLAUDE_MEM_WORKER_INGEST_TOKEN: token, CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY: '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exit !== 0) throw new Error(`client exited ${exit}: ${stderr}`);
  return JSON.parse(stdout.trim().split('\n').pop()!) as { elapsedMs: number; entries: unknown[] };
}

describe('remote hook spool forwarding', () => {
  it('hands the event to a different spool and removes the acknowledged client copy', async () => {
    expect((await child('observation')).entries).toEqual([]);
    expect(spool.entries()).toHaveLength(1);
    expect(spool.entries()[0].payload).toMatchObject({ toolUseId: 'client-tool-1', toolResponse: 'client routing rule' });
    expect(requestPaths).toEqual(['/api/spool/ingest']);
  });

  it('coalesces Stop events without stranding the summary or session end', async () => {
    expect((await child('stop')).entries).toEqual([]);
    expect(spool.entries().map(e => e.kind)).toEqual(['advisor_calls', 'summarize', 'session_end']);
  });

  it('retains capture while offline and replays it on the next hook after recovery', async () => {
    await close();
    const offline = await child('observation');
    expect(offline.entries).toHaveLength(1);
    const original = offline.entries[0];
    await listen();
    expect((await child('flush')).entries).toEqual([]);
    expect(spool.entries()).toEqual([original]);
  });

  it('never interprets a legacy bodyless nudge response as event acceptance', async () => {
    mode = 'legacy';
    expect((await child('observation')).entries).toHaveLength(1);
    expect(spool.entries()).toEqual([]);
  });

  it('retains the event when the acknowledgement names a different event', async () => {
    mode = 'wrong-ack';
    expect((await child('observation')).entries).toHaveLength(1);
  });

  it('retains an event with missing or rejected credentials', async () => {
    expect((await child('observation', '')).entries).toHaveLength(1);
    expect(requestPaths).toEqual([]);
    expect((await child('flush', 'incorrect-token')).entries).toHaveLength(1);
    expect(spool.entries()).toEqual([]);
  });

  it('preserves a permanently rejected event in quarantine and still delivers the next valid event', async () => {
    expect((await child('poison')).entries).toEqual([]);
    expect(spool.entries()).toHaveLength(1);
    expect(spool.entries()[0].payload).toMatchObject({ toolUseId: 'client-tool-1' });
    const rejected = join(directory, 'client/state/hook-spool/corrupt');
    const { readdirSync, readFileSync } = await import('fs');
    expect(readdirSync(rejected)).toHaveLength(1);
    expect(readFileSync(join(rejected, readdirSync(rejected)[0]), 'utf8')).toContain('rejected capture');
  });

  it('bounds an upload whose response body never completes', async () => {
    mode = 'stalled-body';
    const result = await child('observation');
    expect(result.entries).toHaveLength(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(REMOTE_SPOOL_TIMEOUT_MS - 100);
    expect(result.elapsedMs).toBeLessThan(REMOTE_SPOOL_TIMEOUT_MS + 700);
  });
});

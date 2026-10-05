import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const coworkDir = join(import.meta.dir, '..', 'cowork');
const manifest = JSON.parse(readFileSync(join(coworkDir, 'hooks', 'hooks.json'), 'utf8'));
const sessionInitHook = manifest.hooks.UserPromptSubmit[0].hooks[0];
const subprocessGuardMs = 30_000;
const node = Bun.which('node');
const prompt = 'Keep this submitted prompt for the observer.';
const input = { session_id: 'cowork-timeout-session', cwd: '/workspace/timeout-fixture', prompt };

describe('Cowork session-init captures prompts asynchronously', () => {
  let home: string;
  let spool: string;
  let server: Server;
  let apiBase: string;
  let responseDelayMs: number | null;
  let received: Array<{ method?: string; url?: string; auth?: string; body: any }>;
  let sockets: Set<Socket>;
  let timers: Set<ReturnType<typeof setTimeout>>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cowork-session-init-timeout-'));
    spool = join(home, '.claude-mem', 'cowork-spool.jsonl');
    responseDelayMs = null;
    received = [];
    sockets = new Set();
    timers = new Set();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        if (responseDelayMs === null) return; // Stay silent until the shim's HTTP deadline aborts.
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end('{"accepted":1}');
        }, responseDelayMs);
        timers.add(timer);
      });
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mock server did not bind a TCP port');
    apiBase = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const timer of timers) clearTimeout(timer);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
    rmSync(home, { recursive: true, force: true });
  });

  function runSessionInit(): Promise<{ error: ExecFileException | null; stdout: string; stderr: string; elapsedMs: number }> {
    if (!node) throw new Error('Node is required to exercise the shipped Cowork hook');
    const startedAt = Date.now();
    return new Promise(resolve => {
      const child = execFile(node, [join(coworkDir, 'scripts', 'cmem-hook.mjs'), 'session-init'], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CMEM_API_BASE: apiBase,
          CMEM_API_KEY: 'cowork-test-key',
          CMEM_USER_ID: 'cowork-test-user',
          CMEM_SYNC_HUB_URL: apiBase,
        },
        encoding: 'utf8',
        // Test-only guard against a hung subprocess; the hook has no registered timeout.
        timeout: subprocessGuardMs,
        windowsHide: true,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr, elapsedMs: Date.now() - startedAt }));
      child.stdin!.end(JSON.stringify(input));
    });
  }

  it('registers session-init as a background command without a hook timeout', () => {
    expect(sessionInitHook).toMatchObject({
      type: 'command',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/cmem-hook.mjs" session-init',
      async: true,
    });
    expect(sessionInitHook).not.toHaveProperty('timeout');
  });

  it('spools a stalled background ingest when its HTTP request times out', async () => {
    const result = await runSessionInit();

    expect(result.error).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(8000);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: 'POST', url: '/api/hooks/ingest', auth: 'Bearer cowork-test-key',
      body: { event: 'session-init', session_id: input.session_id, payload: input },
    });
    const queued = readFileSync(spool, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ event: 'session-init', project: 'cmem_work_timeout-fixture', payload: input });
  }, subprocessGuardMs + 5000);

  it('completes a background ingest and backlog replay that together exceed eight seconds', async () => {
    responseDelayMs = 4500;
    const backlog = {
      v: 1, platform: 'cowork', event: 'session-init', project: 'cmem_work_timeout-fixture',
      session_id: 'earlier-session', ts: 1,
      payload: { session_id: 'earlier-session', cwd: input.cwd, prompt: 'An earlier queued prompt.' },
    };
    mkdirSync(join(home, '.claude-mem'));
    writeFileSync(spool, JSON.stringify(backlog) + '\n', { mode: 0o600 });

    const result = await runSessionInit();

    expect(result.error).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(responseDelayMs * 2);
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ method: 'POST', url: '/api/hooks/ingest', body: { event: 'session-init', payload: input } });
    expect(received[1]).toMatchObject({ method: 'POST', url: '/api/hooks/ingest', body: { v: 1, batch: [backlog] } });
    expect(existsSync(spool)).toBe(false);
    expect(readdirSync(join(home, '.claude-mem'))).toEqual([]); // No orphaned replay claim.
  }, subprocessGuardMs + 5000);
});

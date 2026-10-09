import { describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { HookSpoolRoutes } from '../../src/services/worker/http/routes/HookSpoolRoutes.js';

describe('remote upload scheduling', () => {
  it('does not scan or drain the outbox in the hook process, and the detached upload delivers it', async () => {
    const root = join(import.meta.dir, '..', '..');
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-upload-scheduling-'));
    const spool = new HookSpool(join(directory, 'worker-spool'));
    const app = express();
    app.use(express.json());
    new HookSpoolRoutes(spool, () => ({
      isConsumed: () => false, markConsumed() {}, clearConsumed() {}, pruneConsumedBefore() {},
    }), () => {}, () => 'test-ingest-token').setupRoutes(app);
    const server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no bound port');
      const source = `
        const { spyOn } = await import('bun:test');
        const { HookSpool } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/shared/hook-spool.ts')).href)});
        const { spoolHookEvent, settleHookSpoolNudges } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/cli/spool-hook-event.ts')).href)});
        spyOn(HookSpool.prototype, 'entries').mockImplementation(() => { throw new Error('hook scanned payloads'); });
        spyOn(HookSpool.prototype, 'drain').mockImplementation(() => { throw new Error('hook drained payloads'); });
        const started = performance.now();
        spoolHookEvent('observation', { contentSessionId: 'scheduling-session', platformSource: 'codex', toolName: 'exec_command', toolUseId: 'schedule-1', toolInput: { cmd: 'read fixture' }, toolResponse: 'detached capture', cwd: '/repo' });
        await settleHookSpoolNudges();
        console.log(JSON.stringify({ elapsedMs: performance.now() - started }));
      `;
      const child = Bun.spawn([process.execPath, '-e', source], {
        cwd: root,
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'client'),
          CLAUDE_PLUGIN_ROOT: join(root, 'plugin'), CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
          CLAUDE_MEM_WORKER_PORT: String(address.port), CLAUDE_MEM_WORKER_AUTOSTART: 'false',
          CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: 'http', CLAUDE_MEM_WORKER_INGEST_TOKEN: 'test-ingest-token',
          CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY: '0' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (exit !== 0) throw new Error(`hook exited ${exit}: ${stderr}`);
      expect(JSON.parse(stdout.trim().split('\n').pop()!).elapsedMs).toBeLessThan(500);
      const deadline = Date.now() + 10000;
      while (!spool.hasEntries() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(spool.entries()).toHaveLength(1);
      const client = new HookSpool(join(directory, 'client/state/hook-spool'));
      while (client.hasEntries() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(client.hasEntries()).toBe(false);
      expect(readdirSync(join(directory, 'client')).some(file => file.endsWith('.db'))).toBe(false);
      expect(existsSync(join(directory, 'client/chroma'))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

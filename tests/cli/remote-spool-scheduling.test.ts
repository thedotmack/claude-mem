import { describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { HookSpoolRoutes } from '../../src/services/worker/http/routes/HookSpoolRoutes.js';

const root = join(import.meta.dir, '..', '..');

async function schedulingScenario(scenario: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-upload-lifecycle-'));
  const source = `
    const { spyOn, expect } = await import('bun:test');
    const childProcess = await import('child_process');
    const { EventEmitter } = await import('events');
    const uploads = [];
    let failSpawn = false;
    let attempts = 0;
    spyOn(childProcess, 'spawn').mockImplementation(() => {
      attempts++;
      if (failSpawn) { failSpawn = false; throw new Error('fixture spawn failure'); }
      const child = new EventEmitter();
      child.unref = () => child;
      uploads.push(child);
      return child;
    });
    const { nudgeWorkerToDrainHookSpool: nudge, settleHookSpoolNudges: settle } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/cli/spool-hook-event.ts')).href)});
    ${scenario}
  `;
  try {
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: root,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_PLUGIN_ROOT: join(root, 'plugin'),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_AUTOSTART: 'false',
        CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: 'http', CLAUDE_MEM_WORKER_INGEST_TOKEN: 'test-ingest-token',
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exit !== 0) throw new Error(`scheduling scenario exited ${exit}: ${stderr}\n${stdout}`);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

describe('remote upload scheduling', () => {
  it('shares one upload per burst and schedules one follow-up for events arriving during delivery', async () => {
    await schedulingScenario(`
      for (let i = 0; i < 8; i++) void nudge();
      await settle();
      expect(uploads).toHaveLength(1);
      for (let i = 0; i < 8; i++) void nudge();
      await settle();
      expect(uploads).toHaveLength(1);
      uploads[0].emit('exit', 0);
      await settle();
      expect(uploads).toHaveLength(2);
      uploads[1].emit('exit', 0);
      await settle();
      expect(uploads).toHaveLength(2);
    `);
  });

  it('allows a later event to retry after an uploader error or unsuccessful exit', async () => {
    await schedulingScenario(`
      void nudge();
      await settle();
      uploads[0].emit('error', new Error('fixture launch error'));
      await settle();
      expect(uploads).toHaveLength(1);
      void nudge();
      await settle();
      expect(uploads).toHaveLength(2);
      uploads[0].emit('exit', 1);
      void nudge();
      await settle();
      expect(uploads).toHaveLength(2);
      uploads[1].emit('exit', 1);
      await settle();
      expect(uploads).toHaveLength(3);
      uploads[2].emit('exit', 0);
    `);
  });

  it('allows another attempt after spawn throws synchronously', async () => {
    await schedulingScenario(`
      failSpawn = true;
      void nudge();
      await settle();
      expect(attempts).toBe(1);
      expect(uploads).toHaveLength(0);
      void nudge();
      await settle();
      expect(attempts).toBe(2);
      expect(uploads).toHaveLength(1);
      uploads[0].emit('exit', 0);
    `);
  });

  it.each([false, true])('delivers a burst with real uploaders without scanning the hook outbox (late event: %s)', async lateEvent => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-upload-scheduling-'));
    const spool = new HookSpool(join(directory, 'worker-spool'));
    const app = express();
    app.use(express.json());
    let requests = 0;
    app.use((_req, _res, next) => {
      requests++;
      if (lateEvent && requests === 1) {
        writeFileSync(join(directory, 'upload-started'), 'ready');
        setTimeout(next, 150);
      } else next();
    });
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
        const { spyOn, expect } = await import('bun:test');
        const { existsSync } = await import('fs');
        const childProcess = await import('child_process');
        const realSpawn = childProcess.spawn;
        let uploads = 0;
        spyOn(childProcess, 'spawn').mockImplementation((...args) => { uploads++; return realSpawn(...args); });
        const { HookSpool } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/shared/hook-spool.ts')).href)});
        const { spoolHookEvent, settleHookSpoolNudges } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/cli/spool-hook-event.ts')).href)});
        spyOn(HookSpool.prototype, 'entries').mockImplementation(() => { throw new Error('hook scanned payloads'); });
        spyOn(HookSpool.prototype, 'drain').mockImplementation(() => { throw new Error('hook drained payloads'); });
        const started = performance.now();
        for (let i = 0; i < 8; i++) {
          spoolHookEvent('observation', { contentSessionId: 'scheduling-session', platformSource: 'codex', toolName: 'exec_command', toolUseId: 'schedule-' + i, toolInput: { cmd: 'read fixture' }, toolResponse: 'detached capture', cwd: '/repo' });
        }
        await settleHookSpoolNudges();
        const elapsedMs = performance.now() - started;
        expect(uploads).toBe(1);
        if (${lateEvent}) {
          const deadline = Date.now() + 8000;
          const ready = ${JSON.stringify(join(directory, 'upload-started'))};
          while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
          expect(existsSync(ready)).toBe(true);
          spoolHookEvent('observation', { contentSessionId: 'scheduling-session', platformSource: 'codex', toolName: 'exec_command', toolUseId: 'late-event', toolInput: {}, toolResponse: 'arrived during delivery', cwd: '/repo' });
          await settleHookSpoolNudges();
          expect(uploads).toBe(1);
          while (new HookSpool().hasEntries() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          expect(new HookSpool().hasEntries()).toBe(false);
        }
        console.log(JSON.stringify({ elapsedMs, uploads }));
      `;
      const child = Bun.spawn([process.execPath, '-e', source], {
        cwd: root,
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'client'),
          // Pin the uploader to this checkout's build; otherwise an installed
          // marketplace/cache plugin of the same or newer version wins resolution.
          CLAUDE_MEM_WORKER_SCRIPT_PATH: join(root, 'plugin', 'scripts', 'worker-service.cjs'),
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
      const result = JSON.parse(stdout.trim().split('\n').pop()!);
      expect(result.elapsedMs).toBeLessThan(500);
      expect(result.uploads).toBe(lateEvent ? 2 : 1);
      const deadline = Date.now() + 10000;
      const expected = lateEvent ? 9 : 8;
      while (spool.entries().length < expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(spool.entries()).toHaveLength(expected);
      expect(requests).toBe(expected);
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
  }, 15000);
});

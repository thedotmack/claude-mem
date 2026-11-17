import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeProjectsDir, ingestMemorySource, scanMemorySource } from '../../src/services/memory/ingest.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MemoryIngestRoutes } from '../../src/services/worker/http/routes/MemoryIngestRoutes.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

describe('native memory project lookup across transcript chunks', () => {
  let root: string;
  let cwd: string;
  let memory: string;
  let transcript: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-transcript-cwd-'));
    cwd = join(root, 'demo-project');
    mkdirSync(cwd);
    const projectDir = join(root, '-workspace-demo-project');
    memory = join(projectDir, 'memory');
    mkdirSync(memory, { recursive: true });
    transcript = join(projectDir, 'session.jsonl');
    writeFileSync(join(memory, 'deployment.md'), '# Deployment\nKeep incremental rollouts.');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves the native user record after a long first prompt', async () => {
    // Claude Code emits queue records before the first user record. Its cwd
    // is in that record even when pasted diagnostics make it exceed 16 KiB.
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'native-session' },
      { type: 'queue-operation', operation: 'remove', sessionId: 'native-session' },
      { type: 'user', cwd, message: { role: 'user', content: 'deployment diagnostic line\n'.repeat(1400) } },
    ];
    writeFileSync(transcript, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
    const [ref] = await scanMemorySource(memory, { root });
    expect(ref.cwd).toBe(cwd);
    expect(ref.project).toBe('demo-project');
  });

  it('keeps requireCwd imports instead of silently skipping their notes', async () => {
    writeFileSync(transcript, JSON.stringify({ type: 'user', cwd, message: { content: 'log line\n'.repeat(5000) } }) + '\n');
    const stored: string[] = [];
    const report = await ingestMemorySource(memory, { root, requireCwd: true }, {
      storeMemoryObservation: async observation => {
        stored.push(observation.project);
        return { id: 1, deduped: false };
      },
    });
    expect(stored).toEqual(['demo-project']);
    expect(report).toMatchObject({ stored: 1, skipped: 0, cwdUnresolvedDirs: 0 });
  });

  it('preserves a cwd whose UTF-8 character crosses the read boundary', async () => {
    const unicodeCwd = join(root, '研究-project');
    mkdirSync(unicodeCwd);
    const before = '{"type":"user","message":{"content":"';
    const after = '"},"cwd":"';
    const encodedCwd = JSON.stringify(unicodeCwd).slice(1, -1);
    const asciiCwd = encodedCwd.slice(0, encodedCwd.indexOf('研'));
    const padding = 'x'.repeat(16383 - Buffer.byteLength(before + after + asciiCwd));
    writeFileSync(transcript, before + padding + after + encodedCwd + '"}\n');
    const [ref] = await scanMemorySource(memory, { root });
    expect(ref.cwd).toBe(unicodeCwd);
    expect(ref.project).toBe('研究-project');
  });

  it('reads a complete final record without a trailing newline after long metadata', async () => {
    const metadata = JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: 'x'.repeat(20000) } });
    writeFileSync(transcript, metadata + '\nnot-json\n' + JSON.stringify({ type: 'user', cwd }));
    expect((await scanMemorySource(memory, { root }))[0].cwd).toBe(cwd);
  });

  it('retains the first cwd rather than a later changed working directory', async () => {
    writeFileSync(transcript, [
      { type: 'user', cwd },
      { type: 'assistant', cwd: join(root, 'other-project'), message: { content: 'x'.repeat(40000) } },
    ].map(row => JSON.stringify(row)).join('\n'));
    expect((await scanMemorySource(memory, { root }))[0].cwd).toBe(cwd);
  });

  it('keeps the unresolved fallback for a transcript without a usable cwd', async () => {
    writeFileSync(transcript, '{"type":"user","message":');
    const [ref] = await scanMemorySource(memory, { root });
    expect(ref.cwd).toBeUndefined();
    expect(ref.project).toBe('project');
  });
});

describe('memory import transcript scan HTTP responsiveness', () => {
  for (const record of ['complete records without cwd', 'an unfinished long record'] as const) {
    it(`serves another request while scanning ${record}`, async () => {
      const projects = claudeProjectsDir();
      mkdirSync(projects, { recursive: true });
      const projectDir = mkdtempSync(join(projects, 'memory-cwd-responsive-'));
      const memory = join(projectDir, 'memory');
      mkdirSync(memory);
      writeFileSync(join(memory, 'deployment.md'), '# Deployment\nKeep incremental rollouts.');
      const line = JSON.stringify({ type: 'progress', data: 'x'.repeat(4096) }) + '\n';
      writeFileSync(join(projectDir, 'session.jsonl'), record === 'complete records without cwd'
        ? line.repeat(2048)
        : '{"type":"user","message":{"content":"' + 'x'.repeat(8 * 1024 * 1024));

      const store = new SessionStore(':memory:');
      const app = express();
      app.use(express.json());
      let finished = false;
      let started!: () => void;
      const scanning = new Promise<void>(resolve => { started = resolve; });
      app.use('/api/memory/ingest', (_req, res, next) => {
        res.once('finish', async () => { finished = true; });
        started();
        next();
      });
      new MemoryIngestRoutes({
        getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
      } as unknown as DatabaseManager).setupRoutes(app);
      app.get('/health', (_req, res) => { res.json({ ingestFinished: finished }); });
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
      const url = `http://127.0.0.1:${address.port}`;
      let importing: Promise<Response> | undefined;
      try {
        importing = fetch(`${url}/api/memory/ingest`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: memory, requireCwd: true }),
        });
        await scanning;
        const health = await fetch(`${url}/health`);
        const healthBody = await health.json();
        const response = await importing;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ stored: 0, skipped: 1, cwdUnresolvedDirs: 1 });
        expect(health.status).toBe(200);
        // Order, rather than a wall-clock threshold: the worker can answer
        // while it is still reading the transcript from disk.
        expect(healthBody.ingestFinished).toBe(false);
      } finally {
        await importing?.catch(() => {});
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        store.close();
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  }
});

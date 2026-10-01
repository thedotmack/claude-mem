// Gate P2-4: the CLI's `project merge` runs inside the running worker, which
// holds the Chroma writer lock (a merge run in a second process could update
// SQLite but never Chroma). Only when no worker answers does the CLI process run
// the merge itself; it is then the only writer.
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => ({})
    })
  }
}));

import { runProjectMergeCommand } from '../../../src/services/infrastructure/ProjectMerge.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { clearPortCache } from '../../../src/shared/worker-utils.js';

const WORKER_ENV_KEYS = ['CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST'] as const;
const savedWorkerEnv = Object.fromEntries(WORKER_ENV_KEYS.map(key => [key, process.env[key]]));

let server: Server | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  for (const key of WORKER_ENV_KEYS) {
    if (savedWorkerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedWorkerEnv[key];
  }
  clearPortCache();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

async function startFakeWorker(handler: express.RequestHandler): Promise<number> {
  const app = express();
  app.use(express.json());
  app.post('/api/projects/merge', handler);
  return new Promise<number>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') reject(new Error('fake worker did not bind a port'));
      else resolve(addr.port);
    });
  });
}

async function closedPort(): Promise<number> {
  const probe = express().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => probe.once('listening', () => resolve()));
  const addr = probe.address();
  const portNumber = addr && typeof addr !== 'string' ? addr.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return portNumber;
}

function pointAtWorker(port: number): void {
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  process.env.CLAUDE_MEM_WORKER_PORT = String(port);
  clearPortCache();
}

function seedDatabase(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-merge-command-'));
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  const store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
  const sessionDbId = store.createSDKSession('content-frontend', 'frontend', 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-frontend');
  store.importObservation({
    memory_session_id: 'memory-frontend',
    project: 'frontend',
    text: 'work',
    type: 'discovery',
    title: 'work in frontend',
    subtitle: null,
    facts: null,
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(1_700_000_000_000).toISOString(),
    created_at_epoch: 1_700_000_000_000,
  });
  store.close();
  return dataDirectory;
}

describe('project merge from the CLI (gate P2-4)', () => {
  it('runs the merge inside the running worker', async () => {
    const received: unknown[] = [];
    pointAtWorker(await startFakeWorker((req, res) => {
      received.push(req.body);
      res.json({ from: 'frontend', into: 'work', mergedObservations: 3, mergedSummaries: 1, chromaUpdates: 4, chromaFailed: 0, dryRun: false });
    }));

    const result = await runProjectMergeCommand({ from: 'frontend', into: 'work' });

    expect(received).toEqual([{ from: 'frontend', into: 'work', dryRun: false }]);
    expect(result).toMatchObject({ ranIn: 'worker', mergedObservations: 3, chromaUpdates: 4 });
  });

  it('runs the merge in this process when no worker answers', async () => {
    const dataDirectory = seedDatabase();
    pointAtWorker(await closedPort());

    const result = await runProjectMergeCommand({ from: 'frontend', into: 'work', dataDirectory });

    expect(result).toMatchObject({ ranIn: 'cli', mergedObservations: 1, chromaUpdates: 1 });
  });

  it('fails loudly when the worker refuses the merge instead of running it twice', async () => {
    pointAtWorker(await startFakeWorker((_req, res) => {
      res.status(500).json({ error: 'database is locked' });
    }));

    await expect(runProjectMergeCommand({ from: 'frontend', into: 'work' })).rejects.toThrow('database is locked');
  });
});

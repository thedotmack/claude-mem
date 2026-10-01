// Gate P2-4: the CLI's `project merge` runs inside the running worker, which
// holds the Chroma writer lock (a merge run in a second process could update
// SQLite but never Chroma). Only when no worker answers does the CLI process run
// the merge itself; it is then the only writer.
//
// The worker request is passed in directly: many test files mock the shared
// worker-utils module for the whole test process.
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

type WorkerRequest = NonNullable<Parameters<typeof runProjectMergeCommand>[1]>;

let server: Server | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

/** A fake worker serving the merge route, and a request function aimed at it. */
async function fakeWorker(handler: express.RequestHandler): Promise<WorkerRequest> {
  const app = express();
  app.use(express.json());
  app.post('/api/projects/merge', handler);
  const port = await new Promise<number>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') reject(new Error('fake worker did not bind a port'));
      else resolve(addr.port);
    });
  });
  return (apiPath, options = {}) => fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
}

const noWorker: WorkerRequest = async () => {
  throw new TypeError('fetch failed: connection refused');
};

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
    const requestWorker = await fakeWorker((req, res) => {
      received.push(req.body);
      res.json({ from: 'frontend', into: 'work', mergedObservations: 3, mergedSummaries: 1, chromaUpdates: 4, chromaFailed: 0, dryRun: false });
    });

    const result = await runProjectMergeCommand({ from: 'frontend', into: 'work' }, requestWorker);

    expect(received).toEqual([{ from: 'frontend', into: 'work', dryRun: false }]);
    expect(result).toMatchObject({ ranIn: 'worker', mergedObservations: 3, chromaUpdates: 4 });
  });

  it('runs the merge in this process when no worker answers', async () => {
    const dataDirectory = seedDatabase();

    const result = await runProjectMergeCommand({ from: 'frontend', into: 'work', dataDirectory }, noWorker);

    expect(result).toMatchObject({ ranIn: 'cli', mergedObservations: 1, chromaUpdates: 1 });
  });

  it('runs the merge in this process when the worker predates the merge route', async () => {
    const dataDirectory = seedDatabase();
    const requestWorker = await fakeWorker((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    const result = await runProjectMergeCommand({ from: 'frontend', into: 'work', dataDirectory }, requestWorker);

    expect(result).toMatchObject({ ranIn: 'cli', mergedObservations: 1 });
  });

  it('fails loudly when the worker refuses the merge instead of running it twice', async () => {
    const requestWorker = await fakeWorker((_req, res) => {
      res.status(500).json({ error: 'database is locked' });
    });

    await expect(runProjectMergeCommand({ from: 'frontend', into: 'work' }, requestWorker)).rejects.toThrow('database is locked');
  });
});

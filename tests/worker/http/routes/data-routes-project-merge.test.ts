// Gate P2-4: `project merge` has to patch Chroma, and only the worker can (it
// holds the Chroma writer lock; a second process is refused), so the merge runs
// through a worker route. The merge re-keys memory and syncs to every device, so
// browser pages on other localhost origins may not call it.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => ({})
    })
  }
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';

let server: Server | undefined;
let port = 0;
let dataDirectory: string;
let savedDataDir: string | undefined;
let observationId: number;

afterAll(() => {
  mock.module('../../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

beforeEach(async () => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'claude-mem-merge-route-'));
  savedDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = dataDirectory;

  const store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
  const sessionDbId = store.createSDKSession('content-frontend', 'frontend', 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-frontend');
  observationId = store.importObservation({
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
  }).id;
  store.close();

  const routes = new DataRoutes({} as any, {} as any, {} as any, {} as any, {} as any, Date.now());
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('project merge test server did not bind a port'));
        return;
      }
      port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(err => (err ? reject(err) : resolve()));
    server = undefined;
  });
  if (savedDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = savedDataDir;
  rmSync(dataDirectory, { recursive: true, force: true });
});

function postMerge(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/projects/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function mergedInto(): string | null {
  const store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
  const row = store.db.prepare('SELECT merged_into_project FROM observations WHERE id = ?').get(observationId) as { merged_into_project: string | null };
  store.close();
  return row.merged_into_project;
}

describe('POST /api/projects/merge (gate P2-4)', () => {
  it('merges inside the worker and patches Chroma', async () => {
    const response = await postMerge({ from: 'frontend', into: 'work' });
    expect(response.status).toBe(200);
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({ from: 'frontend', into: 'work', mergedObservations: 1, chromaUpdates: 1, chromaFailed: 0, dryRun: false });
    expect(mergedInto()).toBe('work');
  });

  it('refuses a browser page on another localhost origin', async () => {
    const response = await postMerge({ from: 'frontend', into: 'work' }, { Origin: 'http://localhost:5173' });
    expect(response.status).toBe(403);
    expect(mergedInto()).toBeNull();
  });

  it('rejects a request that does not name both projects', async () => {
    const response = await postMerge({ from: 'frontend' });
    expect(response.status).toBe(400);
    expect(mergedInto()).toBeNull();
  });
});

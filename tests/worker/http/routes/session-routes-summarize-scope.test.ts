// R5-1: POST /api/sessions/summarize summarizes only a session the worker
// knows, and never one whose checkout the user excluded. Before, it created a
// row for any contentSessionId and queued a paid observer call, so a host that
// cannot check exclusions itself (OpenCode, the transcript watcher) leaked
// every idle turn of an excluded checkout.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { logger } from '../../../../src/utils/logger.js';

let server: Server | undefined;
let store: SessionStore | undefined;
let port = 0;
let queueSummarize: ReturnType<typeof mock>;
let checkout: string;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(async () => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
  checkout = mkdtempSync(path.join(tmpdir(), 'claude-mem-summarize-scope-'));
  store = new SessionStore(new Database(':memory:'));
  queueSummarize = mock(async () => {});

  const routes = new SessionRoutes(
    { getSession: () => undefined, queueSummarize } as any,
    { getSessionStore: () => store, getCloudSync: () => null } as any,
    {} as any,
    {} as any,
    {} as any,
    { broadcastSummarizeQueued: () => {} } as any,
    {} as any,
    {} as any,
  );

  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('summarize test server did not bind a port'));
        return;
      }
      port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  loggerSpies.forEach(spy => spy.mockRestore());
  delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(err => (err ? reject(err) : resolve()));
    server = undefined;
  });
  store?.close();
  store = undefined;
  rmSync(checkout, { recursive: true, force: true });
});

async function postSummarize(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function sessionCount(): number {
  return (store!.db.prepare('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).n;
}

describe('POST /api/sessions/summarize scope (R5-1)', () => {
  it('skips a session the worker has no row for, creating none', async () => {
    const reply = await postSummarize({
      contentSessionId: 'opencode-unknown',
      last_assistant_message: 'reply',
      platformSource: 'opencode',
      cwd: checkout,
    });

    expect(reply).toEqual({ status: 'skipped', reason: 'unknown_session' });
    expect(sessionCount()).toBe(0);
    expect(queueSummarize).not.toHaveBeenCalled();
  });

  it('skips a checkout the user excluded, with no observer call', async () => {
    store!.createSDKSession('opencode-excluded', 'secret-project', 'prompt', undefined, 'opencode');
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = path.basename(checkout);

    const reply = await postSummarize({
      contentSessionId: 'opencode-excluded',
      last_assistant_message: 'reply',
      platformSource: 'opencode',
      cwd: checkout,
    });

    expect(reply).toEqual({ status: 'skipped', reason: 'project_excluded' });
    expect(queueSummarize).not.toHaveBeenCalled();
  });

  it('still queues the summary of a known session in a tracked checkout', async () => {
    store!.createSDKSession('opencode-known', 'tracked-project', 'prompt', undefined, 'opencode');

    const reply = await postSummarize({
      contentSessionId: 'opencode-known',
      last_assistant_message: 'reply',
      platformSource: 'opencode',
      cwd: checkout,
    });

    expect(reply).toEqual({ status: 'queued' });
    expect(queueSummarize).toHaveBeenCalledTimes(1);
  });
});

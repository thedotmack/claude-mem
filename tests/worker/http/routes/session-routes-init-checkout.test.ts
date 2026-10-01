// Gate P1-2: the session-init route records the checkout the hook resolved the
// project from, with how that key was derived, so a session that never reports
// an observation still leaves evidence for worktree adoption.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';
import { logger } from '../../../../src/utils/logger.js';

let server: Server | undefined;
let store: SessionStore | undefined;
let port = 0;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

// An entirely private prompt returns right after the session row and its
// checkout are recorded, before the route needs a live generator.
const PRIVATE_PROMPT = '<private>hello</private>';

beforeEach(async () => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];

  store = new SessionStore(new Database(':memory:'));
  const routes = new SessionRoutes(
    { getSession: () => undefined } as any,
    { getSessionStore: () => store, getCloudSync: () => null } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
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
        reject(new Error('session-init test server did not bind a port'));
        return;
      }
      port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  loggerSpies.forEach(spy => spy.mockRestore());
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
});

async function postInit(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function recordedCheckout(contentSessionId: string): { cwd: string | null; project_key_source: string | null } {
  return store!.db
    .prepare('SELECT cwd, project_key_source FROM sdk_sessions WHERE content_session_id = ?')
    .get(contentSessionId) as { cwd: string | null; project_key_source: string | null };
}

describe('session-init records the checkout and how its key was derived (gate P1-2)', () => {
  it('records the checkout with its key source', async () => {
    const response = await postInit({
      contentSessionId: 'init-checkout-1',
      project: 'acme/api',
      prompt: PRIVATE_PROMPT,
      cwd: '/work/api',
      projectKeySource: 'git-remote',
    });
    expect(response.status).toBe(200);
    expect(recordedCheckout('init-checkout-1')).toEqual({ cwd: '/work/api', project_key_source: 'git-remote' });
  });

  // An unknown source (say, a newer hook) must not be recorded as a folder key;
  // the next observation's ingest records the checkout with a source it knows.
  it('records nothing for a key source it does not recognize', async () => {
    const response = await postInit({
      contentSessionId: 'init-checkout-2',
      project: 'acme',
      prompt: PRIVATE_PROMPT,
      cwd: '/work/acme',
      projectKeySource: 'something-new',
    });
    expect(response.status).toBe(200);
    expect(recordedCheckout('init-checkout-2')).toEqual({ cwd: null, project_key_source: null });
  });

  it('records nothing when the hook sends no checkout (older hooks)', async () => {
    const response = await postInit({ contentSessionId: 'init-checkout-3', project: 'acme', prompt: PRIVATE_PROMPT });
    expect(response.status).toBe(200);
    expect(recordedCheckout('init-checkout-3')).toEqual({ cwd: null, project_key_source: null });
  });
});

// A host that cannot run the project resolver itself (the in-process OMP hook,
// #3556) sends only its cwd; the worker names the project with the same
// resolver the CLI hooks use.
describe('session-init resolves the project from a host cwd (#3556)', () => {
  let checkout: string;

  beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), 'omp-init-checkout-'));
  });

  afterEach(() => {
    delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
    rmSync(checkout, { recursive: true, force: true });
  });

  it('names the project and records the checkout when the host sends no project', async () => {
    const response = await postInit({ contentSessionId: 'init-cwd-1', prompt: PRIVATE_PROMPT, cwd: checkout });
    expect(response.status).toBe(200);

    const context = getProjectContext(checkout);
    const row = store!.db
      .prepare('SELECT project, cwd, project_key_source FROM sdk_sessions WHERE content_session_id = ?')
      .get('init-cwd-1');
    expect(row).toEqual({ project: context.primary, cwd: checkout, project_key_source: context.keySource });
  });

  it('keeps the project a hook resolved itself', async () => {
    await postInit({ contentSessionId: 'init-cwd-2', project: 'acme/api', prompt: PRIVATE_PROMPT, cwd: checkout });
    const row = store!.db
      .prepare('SELECT project FROM sdk_sessions WHERE content_session_id = ?')
      .get('init-cwd-2') as { project: string };
    expect(row.project).toBe('acme/api');
  });

  it('creates no session for a checkout the user excluded', async () => {
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = basename(checkout);
    const response = await postInit({ contentSessionId: 'init-cwd-3', prompt: 'secret work', cwd: checkout });

    expect(await response.json()).toEqual({ skipped: true, reason: 'project_excluded' });
    expect(store!.db.prepare('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
  });
});

// Gate P1-2: the session-init route records the checkout the hook resolved the
// project from, with how that key was derived, so a session that never reports
// an observation still leaves evidence for worktree adoption.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { logger } from '../../../../src/utils/logger.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';

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

// #3803: the OpenCode plugin runs inside OpenCode's process and sends only its
// checkout. The route keys the session with the shared resolver, the one
// observation ingest already applies to that host's tool events.
describe('session-init keys a checkout-only host with the shared resolver (#3803)', () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  function sessionRow(contentSessionId: string): { project: string; cwd: string | null; project_key_source: string | null } {
    return store!.db
      .prepare('SELECT project, cwd, project_key_source FROM sdk_sessions WHERE content_session_id = ?')
      .get(contentSessionId) as { project: string; cwd: string | null; project_key_source: string | null };
  }

  it('keys a linked worktree as parent/leaf and records the checkout as path-derived', async () => {
    // What `git worktree add` leaves on disk: a `.git` FILE pointing into the
    // parent repository's .git/worktrees directory.
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-init-checkout-'));
    const parentRepo = path.join(fixtureRoot, 'parent-repo');
    mkdirSync(path.join(parentRepo, '.git', 'worktrees', 'leaf-worktree'), { recursive: true });
    const worktreeDir = path.join(fixtureRoot, 'leaf-worktree');
    mkdirSync(worktreeDir);
    writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${path.join(parentRepo, '.git', 'worktrees', 'leaf-worktree')}\n`);

    const response = await postInit({
      contentSessionId: 'init-checkout-only',
      prompt: PRIVATE_PROMPT,
      cwd: worktreeDir,
      platformSource: 'opencode',
    });

    expect(response.status).toBe(200);
    expect(sessionRow('init-checkout-only')).toEqual({
      project: getProjectContext(worktreeDir).primary,
      cwd: worktreeDir,
      project_key_source: 'path',
    });
    expect(sessionRow('init-checkout-only').project).toBe('parent-repo/leaf-worktree');
  });

  it('keeps the project a hook resolved itself', async () => {
    const response = await postInit({
      contentSessionId: 'init-hook-project',
      project: 'from-the-hook',
      prompt: PRIVATE_PROMPT,
      cwd: '/work/elsewhere',
      projectKeySource: 'environment',
    });

    expect(response.status).toBe(200);
    expect(sessionRow('init-hook-project')).toEqual({
      project: 'from-the-hook',
      cwd: '/work/elsewhere',
      project_key_source: 'environment',
    });
  });

  // Such a host cannot check the user's exclusions before it calls (the CLI
  // hooks do), so the route skips an excluded checkout before creating a row
  // (#3556, the OMP hook).
  it('creates no session for a checkout the user excluded', async () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-init-excluded-'));
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = path.basename(fixtureRoot);
    try {
      const response = await postInit({ contentSessionId: 'init-excluded', prompt: 'secret work', cwd: fixtureRoot });

      expect(await response.json()).toEqual({ skipped: true, reason: 'project_excluded' });
      expect(store!.db.prepare('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
    } finally {
      delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
    }
  });
});

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
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { logger } from '../../../../src/utils/logger.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';

let server: Server | undefined;
let store: SessionStore | undefined;
let port = 0;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];
let activeSessions: Map<number, ActiveSession> = new Map();

// An entirely private prompt returns right after the session row and its
// checkout are recorded, before the route needs a live generator.
const PRIVATE_PROMPT = '<private>hello</private>';
// A public prompt reaches the live ActiveSession, so the observer-model handoff
// can be observed on it. Kept distinct from PRIVATE_PROMPT on purpose.
const PUBLIC_PROMPT = 'please summarize the plan';

// Real-shaped live session, matching the harness in native-prompt-init.test.ts.
// Production mutates the object returned by initializeSession, so the test can
// assert the observer model travelled with it.
function makeActiveSession(dbId: number, contentSessionId: string, project: string, promptNumber: number): ActiveSession {
  return {
    sessionDbId: dbId,
    contentSessionId,
    memorySessionId: null,
    project,
    platformSource: 'opencode',
    userPrompt: '',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: promptNumber,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

beforeEach(async () => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];

  store = new SessionStore(new Database(':memory:'));
  activeSessions = new Map();
  // Minimal live-session stub: the nominal, duplicate and Cursor branches all
  // call initializeSession, which returns a real-shaped ActiveSession. With no
  // buffered work the generator gate is a no-op, so no provider is started.
  const sessionManager = {
    getSession: (id: number) => activeSessions.get(id),
    initializeSession: (id: number, prompt: string, promptNumber: number, project: string) => {
      const row = store!.getSessionById(id);
      const session = makeActiveSession(
        id,
        row?.content_session_id ?? '',
        project ?? row?.project ?? 'unknown',
        promptNumber,
      );
      session.userPrompt = prompt;
      activeSessions.set(id, session);
      return session;
    },
    getMessageBuffer: () => ({ getPendingCount: () => 0 }),
  };
  const routes = new SessionRoutes(
    sessionManager as any,
    { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
    {} as any,
    {} as any,
    {} as any,
    { broadcastNewPrompt() {}, broadcastSessionStarted() {} } as any,
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

// The plugin already sends an endpoint-ready observerModel id on session-init;
// the worker must hang it on the live session without touching persistence or
// failing a prompt when the value is malformed.
describe('session-init carries the per-session observer model onto the ActiveSession', () => {
  it('accepts a valid observer model on the live session', async () => {
    const response = await postInit({
      contentSessionId: 'observer-model-accepted',
      project: 'acme/api',
      prompt: PUBLIC_PROMPT,
      observerModel: 'endpoint-model',
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ skipped: false, status: 'initialized' });
    expect(activeSessions.get(body.sessionDbId)?.observerModel).toBe('endpoint-model');
  });

  it('ignores an empty, whitespace-only, oversized, or non-string observer model without failing init', async () => {
    const invalidValues: unknown[] = ['', '   ', '\t\n', 'x'.repeat(201), 42];
    for (const [index, value] of invalidValues.entries()) {
      const response = await postInit({
        contentSessionId: `observer-model-invalid-${index}`,
        project: 'acme/api',
        prompt: `${PUBLIC_PROMPT} ${index}`,
        observerModel: value,
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ skipped: false, status: 'initialized' });
      expect(activeSessions.get(body.sessionDbId)?.observerModel).toBeUndefined();
    }
  });

  it('keeps the observer model on the duplicate-prompt path', async () => {
    // Reuse the native-prompt duplicate setup: the same native id and text is
    // a retry, not a new turn, so it takes the duplicate early return.
    const firstBody = {
      contentSessionId: 'observer-model-duplicate',
      project: 'acme/api',
      prompt: 'repeat me exactly',
      nativePromptId: 'observer-dup-turn',
    };
    const firstResponse = await postInit({ ...firstBody, observerModel: 'first-model' });
    const firstJson = await firstResponse.json() as any;

    expect(firstResponse.status).toBe(200);
    const staleSession = activeSessions.get(firstJson.sessionDbId)!;
    expect(staleSession.observerModel).toBe('first-model');

    // A stale live native turn (lastPromptNumber older than the durable row)
    // makes the duplicate branch repair it with a fresh initializeSession.
    staleSession.lastPromptNumber = 0;

    const duplicateResponse = await postInit({ ...firstBody, observerModel: 'second-model' });
    const duplicateJson = await duplicateResponse.json() as any;

    expect(duplicateResponse.status).toBe(200);
    expect(duplicateJson).toMatchObject({ skipped: true, reason: 'duplicate' });
    // Both the pre-existing session and the repaired one carry the new value.
    expect(staleSession.observerModel).toBe('second-model');
    expect(activeSessions.get(duplicateJson.sessionDbId)?.observerModel).toBe('second-model');
  });

  // Brings a live session to prompt 3 with its own model selection, then posts
  // a retry of the older prompt 2. Shared by the stale-retry regressions below.
  async function liveSessionAtPromptThree(contentSessionId: string, model: string): Promise<ActiveSession> {
    const texts = ['first distinct turn', 'second distinct turn', 'third distinct turn'];
    for (const [index, text] of texts.entries()) {
      const response = await postInit({ contentSessionId, project: 'acme/api', prompt: text });
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      if (index === texts.length - 1) activeSessions.get(json.sessionDbId)!.observerModel = model;
    }
    const session = [...activeSessions.values()][0];
    expect(session.lastPromptNumber).toBe(texts.length);
    expect(session.observerModel).toBe(model);
    return session;
  }

  it('observer-model-old-retry-does-not-overwrite: an older retry cannot replace a newer selection', async () => {
    const liveSession = await liveSessionAtPromptThree('observer-model-old-retry', 'newer-model');

    // The duplicate of prompt 2 carries a different model. Because the live
    // turn is already on prompt 3, the retry must not refresh it.
    const retry = await postInit({
      contentSessionId: 'observer-model-old-retry',
      project: 'acme/api',
      prompt: 'second distinct turn',
      observerModel: 'older-model',
    });
    const retryJson = await retry.json() as any;

    expect(retryJson).toMatchObject({ skipped: true, reason: 'duplicate' });
    expect(liveSession.observerModel).toBe('newer-model');
  });

  it('observer-model-retry-without-field-does-not-clear: a field-less older retry keeps the newer selection', async () => {
    const liveSession = await liveSessionAtPromptThree('observer-model-no-field', 'newer-model');

    const retry = await postInit({
      contentSessionId: 'observer-model-no-field',
      project: 'acme/api',
      prompt: 'second distinct turn',
    });
    const retryJson = await retry.json() as any;

    expect(retryJson).toMatchObject({ skipped: true, reason: 'duplicate' });
    expect(liveSession.observerModel).toBe('newer-model');
  });

  it('observer-model-current-retry-refreshes: a retry of the live turn replaces its model', async () => {
    const contentSessionId = 'observer-model-current-retry';
    const first = await postInit({
      contentSessionId,
      project: 'acme/api',
      prompt: 'live turn text',
      observerModel: 'original-model',
    });
    const firstJson = await first.json() as any;
    const liveSession = activeSessions.get(firstJson.sessionDbId)!;
    expect(liveSession.observerModel).toBe('original-model');

    // Same text at the same prompt number: a current-turn retry (legacy
    // text dedupe), so the host's new model may replace the old one.
    const retry = await postInit({
      contentSessionId,
      project: 'acme/api',
      prompt: 'live turn text',
      observerModel: 'replacement-model',
    });
    const retryJson = await retry.json() as any;

    expect(retryJson).toMatchObject({ skipped: true, reason: 'duplicate' });
    expect(liveSession.observerModel).toBe('replacement-model');
  });

  it('lands the observer model on an existing Cursor session too', async () => {
    const contentSessionId = 'observer-model-cursor';
    // Cursor rows are keyed by platform source, and Cursor creates its observer
    // lazily (an earlier observation), so seed the live session the way that
    // path would before the accepted prompt reaches this branch.
    const firstResponse = await postInit({
      contentSessionId,
      project: 'acme/api',
      prompt: PUBLIC_PROMPT,
      platformSource: 'cursor',
      observerModel: 'first-model',
    });
    const firstJson = await firstResponse.json() as any;
    expect(firstResponse.status).toBe(200);
    activeSessions.set(firstJson.sessionDbId, makeActiveSession(firstJson.sessionDbId, contentSessionId, 'acme/api', 1));

    const cursorResponse = await postInit({
      contentSessionId,
      project: 'acme/api',
      prompt: `${PUBLIC_PROMPT} cursor turn`,
      platformSource: 'cursor',
      observerModel: 'cursor-model',
    });
    const cursorJson = await cursorResponse.json() as any;

    expect(cursorResponse.status).toBe(200);
    expect(cursorJson).toMatchObject({ skipped: false });
    expect(activeSessions.get(cursorJson.sessionDbId)?.observerModel).toBe('cursor-model');
  });
});

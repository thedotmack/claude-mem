// The opencode observer provider's own sub-sessions arrive through the
// OpenCode plugin like user turns. Every spawned prompt starts with the
// sentinel and the reused session id is archived: init, observations and
// summaries for them are skipped before any session row exists, or the
// observer would observe itself forever. Mirrors the Codex helper skip.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { setIngestContext } from '../../../../src/services/worker/http/shared.js';
import { logger } from '../../../../src/utils/logger.js';
import { OBSERVER_PROMPT_SENTINEL } from '../../../../src/shared/observer-sentinel.js';

const SENTINEL_PROMPT = `${OBSERVER_PROMPT_SENTINEL}\nConsider only the latest user message below.`;
const ARCHIVED_ID = 'ses_Observertestabc123X09';

describe('POST /api/sessions/init: opencode observer sub-sessions', () => {
  let server: Server | undefined;
  let store: SessionStore;
  let port = 0;
  let loggerSpies: Array<ReturnType<typeof spyOn>> = [];
  let tempDataDir = '';
  const savedDataDir = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    tempDataDir = join(tmpdir(), `opencode-observer-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDataDir, 'opencode-observer'), { recursive: true });
    writeFileSync(join(tempDataDir, 'opencode-observer', 'observer-session.id'), `${ARCHIVED_ID}\n`);
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;

    store = new SessionStore(new Database(':memory:'));
    const dbStub: any = {
      getSessionStore: () => store,
      getSessionById: (id: number) => store.getSessionById(id),
      getCloudSync: () => null,
      getChromaSync: () => null,
    };
    const sessionManagerStub: any = new SessionManager(dbStub);
    setIngestContext({
      dbManager: dbStub,
      sessionManager: sessionManagerStub,
      eventBroadcaster: new Proxy({}, { get: () => () => {} }) as any,
      ensureGeneratorRunning: async () => {},
    });
    const routes = new SessionRoutes(
      sessionManagerStub, dbStub, {} as any, {} as any, {} as any,
      new Proxy({}, { get: () => () => {} }) as any, {} as any, {} as any,
    );
    const app = express();
    app.use(express.json());
    routes.setupRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        port = addr && typeof addr !== 'string' ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    await new Promise<void>((resolve) => (server?.close(() => resolve()) ?? resolve()));
    store?.close();
    if (savedDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = savedDataDir;
    if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
  });

  async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  function rowCount(): number {
    return (store.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).n;
  }

  it('skips a sentinel init from opencode before creating a session', async () => {
    const body = await post('/api/sessions/init', {
      contentSessionId: `opencode-${ARCHIVED_ID}-1`,
      project: 'opencode-observer',
      prompt: SENTINEL_PROMPT,
      platformSource: 'opencode',
      cwd: tempDataDir,
    });
    expect(body).toEqual({ skipped: true, reason: 'observer_subsession' });
    expect(rowCount()).toBe(0);
  });

  it('skips an archived-id init even with an ordinary prompt', async () => {
    const body = await post('/api/sessions/init', {
      contentSessionId: `opencode-${ARCHIVED_ID}-2`,
      project: 'opencode-observer',
      prompt: 'Reply with exactly: HI',
      platformSource: 'opencode',
      cwd: tempDataDir,
    });
    expect(body).toEqual({ skipped: true, reason: 'observer_subsession' });
    expect(rowCount()).toBe(0);
  });

  it('skips observations and summaries for the archived session without creating rows', async () => {
    const obs = await post('/api/sessions/observations', {
      contentSessionId: `opencode-${ARCHIVED_ID}-3`,
      tool_name: 'Edit',
      tool_input: {},
      tool_response: 'x',
      cwd: tempDataDir,
      platformSource: 'opencode',
    });
    expect(obs).toEqual({ status: 'skipped', reason: 'observer_subsession' });
    const sum = await post('/api/sessions/summarize', {
      contentSessionId: `opencode-${ARCHIVED_ID}-3`,
      platformSource: 'opencode',
      cwd: tempDataDir,
    });
    expect(sum).toEqual({ status: 'skipped', reason: 'observer_subsession' });
    expect(rowCount()).toBe(0);
  });

  it('still records the same text when Claude Code sends it', async () => {
    const body = await post('/api/sessions/init', {
      contentSessionId: 'claude-session',
      project: 'demo',
      prompt: SENTINEL_PROMPT,
      platformSource: 'claude',
      cwd: tempDataDir,
    });
    expect(body.skipped).toBe(false);
    expect(rowCount()).toBe(1);
  });

  it('still records an ordinary opencode prompt', async () => {
    const body = await post('/api/sessions/init', {
      contentSessionId: 'opencode-user-session',
      project: 'demo',
      prompt: 'fix the flaky test',
      platformSource: 'opencode',
      cwd: tempDataDir,
    });
    expect(body.skipped).toBe(false);
    expect(rowCount()).toBe(1);
  });
});

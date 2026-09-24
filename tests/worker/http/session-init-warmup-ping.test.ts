import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { logger } from '../../../src/utils/logger.js';

const WARMUP_PROMPT = 'Warmup ping - reply with the single word: ready';
const ENV_KEYS = [
  'CLAUDE_MEM_OBSERVER_WARMUP_PINGS_ENABLED',
  'CLAUDE_MEM_OBSERVER_WARMUP_PING_INTERVAL_MS',
];

describe('SessionRoutes warmup ping session-init handling', () => {
  let store: SessionStore | undefined;
  let server: Server | undefined;
  let port = 0;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    delete process.env.CLAUDE_MEM_OBSERVER_WARMUP_PINGS_ENABLED;
    delete process.env.CLAUDE_MEM_OBSERVER_WARMUP_PING_INTERVAL_MS;

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
      { broadcastSessionStarted: () => {} } as any,
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
          reject(new Error('warmup ping test server did not bind a port'));
          return;
        }
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
      server = undefined;
    });
    store?.close();
    store = undefined;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  async function postInit(contentSessionId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        project: 'host-project',
        prompt: WARMUP_PROMPT,
        platformSource: 'cursor',
      }),
    });
  }

  it('marks allowed warmup pings as observer_warmup sessions', async () => {
    process.env.CLAUDE_MEM_OBSERVER_WARMUP_PINGS_ENABLED = 'true';
    process.env.CLAUDE_MEM_OBSERVER_WARMUP_PING_INTERVAL_MS = '0';

    const response = await postInit('warmup-allowed');
    expect(response.ok).toBe(true);

    const body = await response.json() as { sessionDbId: number; skipped?: boolean };
    expect(body.skipped).toBeFalse();
    expect(store!.getSessionById(body.sessionDbId)?.session_kind).toBe('observer_warmup');
  });

  it('skips warmup pings entirely when disabled', async () => {
    process.env.CLAUDE_MEM_OBSERVER_WARMUP_PINGS_ENABLED = 'false';

    const response = await postInit('warmup-disabled');
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ skipped: true, reason: 'observer_warmup_disabled' });
    expect(store!.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).toEqual({ n: 0 });
  });

  it('throttles repeated warmup pings within the configured interval', async () => {
    process.env.CLAUDE_MEM_OBSERVER_WARMUP_PINGS_ENABLED = 'true';
    process.env.CLAUDE_MEM_OBSERVER_WARMUP_PING_INTERVAL_MS = '3600000';

    const first = await postInit('warmup-throttle-1');
    const firstBody = await first.json() as { sessionDbId: number; skipped?: boolean };
    expect(firstBody.skipped).toBeFalse();

    const second = await postInit('warmup-throttle-2');
    expect(second.ok).toBe(true);
    await expect(second.json()).resolves.toEqual({ skipped: true, reason: 'observer_warmup_throttled' });

    const count = (store!.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).n;
    expect(count).toBe(1);
    expect(store!.getSessionById(firstBody.sessionDbId)?.session_kind).toBe('observer_warmup');
  });
});

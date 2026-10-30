// The 256 KB session-init prompt cap used to run before the <private> strip.
// A cap that fell inside a block severed its closing tag, the balanced
// stripper then kept the unbalanced remainder verbatim, and the private text
// was stored. The strip now runs first, so the cap only ever cuts public text.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import express from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { logger } from '../../src/utils/logger.js';

const MAX_USER_PROMPT_BYTES = 256 * 1024; // mirrors SessionRoutes.ts

describe('POST /api/sessions/init: private block straddling the prompt cap', () => {
  let server: Server | undefined;
  let db: Database;
  let port = 0;
  let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    db = new Database(':memory:');
    const store = new SessionStore(db);
    const routes = new SessionRoutes(
      { getSession: () => undefined } as any,
      { getSessionStore: () => store, getCloudSync: () => null } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    const app = express();
    // The prompt is larger than express.json's 100 KB default.
    app.use(express.json({ limit: '2mb' }));
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
    loggerSpies.forEach(spy => spy.mockRestore());
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
  });

  it('never stores private text when the cap falls inside a <private> block', async () => {
    // The block opens near the start and closes past the cap: capping first
    // leaves `<private>PRIVATE-…` with no closer, which the stripper keeps.
    const prompt = `fix the build <private>PRIVATE-${'s'.repeat(MAX_USER_PROMPT_BYTES)}</private> then run the tests`;
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: 'cap-session', project: 'demo', prompt, platformSource: 'cursor' }),
    });
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.skipped).toBe(false);

    const stored = db.prepare('SELECT prompt_text FROM user_prompts').all() as Array<{ prompt_text: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].prompt_text).toBe('fix the build  then run the tests');
    const sessions = db.prepare('SELECT user_prompt FROM sdk_sessions').all() as Array<{ user_prompt: string | null }>;
    for (const row of sessions) expect(row.user_prompt ?? '').not.toContain('PRIVATE-');
  });
});

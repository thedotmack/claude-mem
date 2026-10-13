// Codex and the Codex app run their own helper threads (task titles, memory
// consolidation, suggestions) through the same UserPromptSubmit hook as a user
// turn. Each became a claude-mem session and spent observer tokens. The skip
// applies to Codex only: the same text from another host is a person's prompt.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { logger } from '../../../src/utils/logger.js';

const TITLE_PROMPT = 'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task.\n\nUser prompt: fix the flaky test';
const CONSOLIDATION_PROMPT = '## Memory Writing Agent: Phase 2 (Consolidation)\n\nYou are a Memory Writing Agent.';

describe('session-init hook: Codex internal helper prompts', () => {
  const cwd = join(tmpdir(), 'claude-mem-codex-internal-prompt-test');
  let workerCalls: string[] = [];

  beforeEach(() => {
    workerCalls = [];
    setSessionInitDependenciesForTesting({
      shouldTrackProject: () => true,
      loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      isWorkerFallback: () => false,
      executeWithWorkerFallback: async (apiPath: string) => {
        workerCalls.push(apiPath);
        return { sessionDbId: 42, promptNumber: 1 };
      },
    });
  });

  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  for (const prompt of [TITLE_PROMPT, CONSOLIDATION_PROMPT]) {
    it(`does not start a session for a Codex helper prompt (${prompt.slice(0, 24)}…)`, async () => {
      const result = await sessionInitHandler.execute({ sessionId: 'codex-helper', cwd, platform: 'codex', prompt });
      expect(result.continue).toBe(true);
      expect(workerCalls).toEqual([]);
    });
  }

  it('still records the same text when Claude Code sends it', async () => {
    await sessionInitHandler.execute({ sessionId: 'claude-user', cwd, platform: 'claude-code', prompt: TITLE_PROMPT });
    expect(workerCalls).toEqual(['/api/sessions/init']);
  });

  it('still records an ordinary Codex prompt', async () => {
    await sessionInitHandler.execute({ sessionId: 'codex-user', cwd, platform: 'codex', prompt: 'fix the flaky test' });
    expect(workerCalls).toEqual(['/api/sessions/init']);
  });
});

describe('POST /api/sessions/init: Codex internal helper prompts', () => {
  let server: Server | undefined;
  let store: SessionStore;
  let port = 0;
  let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

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
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
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
    loggerSpies.forEach(spy => spy.mockRestore());
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
  });

  async function init(platformSource: string, prompt: string): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: `${platformSource}-session`, project: 'demo', prompt, platformSource }),
    });
    return await response.json() as Record<string, unknown>;
  }

  it('skips a Codex helper prompt before creating a session, with its own reason', async () => {
    expect(await init('codex', TITLE_PROMPT)).toEqual({ skipped: true, reason: 'internal_system_prompt' });
    expect(store.findSessionDbIdByContentSessionId('codex-session', 'codex')).toBeNull();
  });

  it('creates the session when another host sends the same text', async () => {
    // Cursor takes the init path that needs no live generator.
    const body = await init('cursor', TITLE_PROMPT);
    expect(body.skipped).toBe(false);
    expect(store.findSessionDbIdByContentSessionId('cursor-session', 'cursor')).toBe(body.sessionDbId as number);
  });
});

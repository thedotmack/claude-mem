// Codex and the Codex app run their own helper threads (task titles, memory
// consolidation, suggestions) through the same UserPromptSubmit hook as a user
// turn. Each became a claude-mem session and spent observer tokens. The skip
// applies to Codex only: the same text from another host is a person's prompt.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'fs';
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
const GROK_BRIEF = 'Independently verify every candidate claim in the JSON packet below against the cited sources.\n\n{"claims": []}';

describe('session-init hook: internal helper prompts', () => {
  let cwd: string;
  let workerCalls: string[] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'claude-mem-internal-prompt-'));
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
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    ['codex', TITLE_PROMPT, false],
    ['codex', CONSOLIDATION_PROMPT, false],
    ['claude-code', TITLE_PROMPT, true],
    ['codex', 'fix the flaky test', true],
    ['grok-bot', GROK_BRIEF, false],
    ['grok-bot', 'fix the flaky test', true],
    ['claude-code', GROK_BRIEF, true],
  ] as const)('handles %s prompt %s (init=%s)', async (platform, prompt, expectInit) => {
    const result = await sessionInitHandler.execute({ sessionId: 'helper-session', cwd, platform, prompt });
    expect(result.continue).toBe(true);
    expect(workerCalls).toEqual(expectInit ? ['/api/sessions/init'] : []);
  });
});

describe('POST /api/sessions/init: internal helper prompts', () => {
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
    store.close();
  });

  async function init(platformSource: string, prompt: string): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: `${platformSource}-session`, project: 'demo', prompt, platformSource }),
    });
    return await response.json() as Record<string, unknown>;
  }

  it.each([
    ['codex', TITLE_PROMPT, false],
    ['cursor', TITLE_PROMPT, true],
    ['grok-bot', GROK_BRIEF, false],
    ['cursor', GROK_BRIEF, true],
  ] as const)('handles %s prompt %s (init=%s)', async (platform, prompt, expectInit) => {
    const body = await init(platform, prompt);
    const sessionId = store.findSessionDbIdByContentSessionId(`${platform}-session`, platform);
    if (expectInit) {
      expect(body.skipped).toBe(false);
      expect(sessionId).toBe(body.sessionDbId as number);
    } else {
      expect(body).toEqual({ skipped: true, reason: 'internal_system_prompt' });
      expect(sessionId).toBeNull();
    }
  });
});

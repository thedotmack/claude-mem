import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import express from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { logger } from '../../src/utils/logger.js';
import { postHogCaptureCalls } from '../preload';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CLAUDE_MEM_TELEMETRY',
  'CLAUDE_MEM_TELEMETRY_DEBUG',
  'DO_NOT_TRACK',
];

function skillInvokedCalls(): Array<{ event: string; properties: Record<string, unknown> }> {
  return postHogCaptureCalls.filter((call) => call.event === 'skill_invoked') as Array<{
    event: string;
    properties: Record<string, unknown>;
  }>;
}

describe('skill_invoked telemetry', () => {
  let store: SessionStore | undefined;
  let queued: Array<{ sessionDbId: number; data: any }>;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.CLAUDE_MEM_TELEMETRY = '1';
    delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    delete process.env.DO_NOT_TRACK;

    __resetTelemetryForTests();
    postHogCaptureCalls.length = 0;

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
    ];

    queued = [];
    store = new SessionStore(new Database(':memory:'));

    setIngestContext({
      sessionManager: {
        queueObservation: async (sessionDbId: number, data: any) => {
          queued.push({ sessionDbId, data });
        },
      } as any,
      dbManager: { getSessionStore: () => store } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });
  });

  afterEach(() => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    store?.close();
    store = undefined;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    __resetTelemetryForTests();
    postHogCaptureCalls.length = 0;
  });

  const skillPayload = (overrides: Record<string, unknown> = {}) => ({
    contentSessionId: 'content-session-skill',
    toolName: 'Skill',
    toolInput: { skill: 'mem-search', args: '/Users/alice/secret-project --pr 99' },
    toolResponse: { ok: true, text: '# Memory Search\nnever send this' },
    cwd: '/workspace/claude-mem',
    platformSource: 'claude-code',
    toolUseId: 'toolu_skill_01',
    ...overrides,
  });

  it('emits skill_invoked on the tool_excluded Skill skip and still skips observation', async () => {
    const result = await ingestObservation(skillPayload());

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    expect(queued).toHaveLength(0);
    expect(store!.queryToolUses({})).toHaveLength(0);

    expect(skillInvokedCalls()).toHaveLength(1);
    const props = skillInvokedCalls()[0].properties;
    expect(props.skill_id).toBe('mem-search');
    expect(props.skill_source).toBe('first_party');
    expect(props.skill_trigger).toBe('tool');
    expect(props.ide).toBe('claude');
    expect(JSON.stringify(props)).not.toContain('args');
    expect(JSON.stringify(props)).not.toContain('/Users/alice');
    expect(JSON.stringify(props)).not.toContain('secret-project');
    expect(JSON.stringify(props)).not.toContain('Memory Search');
  });

  it('collapses a third-party Skill name to other / third_party', async () => {
    const result = await ingestObservation(skillPayload({
      toolInput: { skill: 'someone-else:evil', args: 'do not leak' },
    }));

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    expect(skillInvokedCalls()).toHaveLength(1);
    const props = skillInvokedCalls()[0].properties;
    expect(props.skill_id).toBe('other');
    expect(props.skill_source).toBe('third_party');
    expect(JSON.stringify(props)).not.toContain('someone-else');
    expect(JSON.stringify(props)).not.toContain('evil');
    expect(JSON.stringify(props)).not.toContain('do not leak');
  });

  it('does not emit skill_invoked for other skipped tools', async () => {
    const result = await ingestObservation(skillPayload({
      toolName: 'SlashCommand',
      toolInput: { command: '/mem-search' },
    }));

    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    expect(skillInvokedCalls()).toHaveLength(0);
  });

  it('does not emit skill_invoked for non-Skill ingested tools', async () => {
    const result = await ingestObservation({
      contentSessionId: 'content-session-read',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.ts' },
      toolResponse: { ok: true },
      cwd: '/workspace/claude-mem',
      toolUseId: 'toolu_read_01',
    });

    expect(result.ok).toBe(true);
    expect(skillInvokedCalls()).toHaveLength(0);
  });

  it('emits nothing when DO_NOT_TRACK is set', async () => {
    process.env.DO_NOT_TRACK = '1';
    __resetTelemetryForTests();
    postHogCaptureCalls.length = 0;

    const result = await ingestObservation(skillPayload());
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    expect(skillInvokedCalls()).toHaveLength(0);
  });

  it('emits nothing when CLAUDE_MEM_TELEMETRY=0', async () => {
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    __resetTelemetryForTests();
    postHogCaptureCalls.length = 0;

    const result = await ingestObservation(skillPayload());
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    expect(skillInvokedCalls()).toHaveLength(0);
  });
});

describe('skill_invoked from session-init slash prompts', () => {
  let store: SessionStore | undefined;
  let server: Server | undefined;
  let port = 0;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.CLAUDE_MEM_TELEMETRY = '1';
    delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    delete process.env.DO_NOT_TRACK;

    __resetTelemetryForTests();
    postHogCaptureCalls.length = 0;

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
    __resetTelemetryForTests();
    postHogCaptureCalls.length = 0;
  });

  afterAll(() => {
    __resetTelemetryForTests();
  });

  async function postInit(body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('emits skill_invoked with skill_trigger prompt for a first-party slash', async () => {
    const response = await postInit({
      contentSessionId: 'slash-session-1',
      project: 'claude-mem',
      prompt: '/mem-search how did we do auth last time?',
      platformSource: 'cursor',
    });

    expect(response.ok).toBe(true);
    expect(skillInvokedCalls()).toHaveLength(1);
    const props = skillInvokedCalls()[0].properties;
    expect(props.skill_id).toBe('mem-search');
    expect(props.skill_source).toBe('first_party');
    expect(props.skill_trigger).toBe('prompt');
    expect(props.ide).toBe('cursor');
    expect(JSON.stringify(props)).not.toContain('how did we do auth');
    expect(JSON.stringify(props)).not.toContain('last time');
  });

  it('emits nothing for an unknown /foo slash and never sends the body', async () => {
    const response = await postInit({
      contentSessionId: 'slash-session-2',
      project: 'claude-mem',
      prompt: '/foo please leak this secret path /Users/alice',
      platformSource: 'cursor',
    });

    expect(response.ok).toBe(true);
    expect(skillInvokedCalls()).toHaveLength(0);
    expect(JSON.stringify(postHogCaptureCalls)).not.toContain('/Users/alice');
    expect(JSON.stringify(postHogCaptureCalls)).not.toContain('please leak');
  });

  it('emits nothing when the prompt is not a leading slash skill', async () => {
    const response = await postInit({
      contentSessionId: 'slash-session-3',
      project: 'claude-mem',
      prompt: 'can you /mem-search later?',
      platformSource: 'cursor',
    });

    expect(response.ok).toBe(true);
    expect(skillInvokedCalls()).toHaveLength(0);
  });
});

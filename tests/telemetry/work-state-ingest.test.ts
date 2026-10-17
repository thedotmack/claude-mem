import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared';
import { telemetryBuffer } from '../../src/services/telemetry/buffer';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';
import { postHogCaptureCalls } from '../preload';
import { recordWorkStatePrivacy, recordWorkStateInstruction } from '../../src/services/telemetry/work-state';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes';
import express from 'express';
import { sessionInitHandler, setSessionInitDependenciesForTesting } from '../../src/cli/handlers/session-init';
import { observationHandler } from '../../src/cli/handlers/observation';
import * as spoolHooks from '../../src/cli/spool-hook-event';
import { HookSpool } from '../../src/shared/hook-spool';
import { drainHookSpool } from '../../src/services/worker/hook-spool-drain';
import { useTempHookSpoolDataDir } from '../helpers/temp-hook-spool';

const ENV = ['CLAUDE_MEM_TELEMETRY', 'DO_NOT_TRACK', 'CLAUDE_MEM_SKIP_TOOLS', 'CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS', 'CLAUDE_MEM_EXCLUDED_PROJECTS'];
let previous: Array<string | undefined>;
let store: SessionStore;
let queue: ReturnType<typeof mock>;
const payload = {
  contentSessionId: 'telemetry-capture', platformSource: 'codex', cwd: '/tmp/telemetry-work',
  toolName: 'TodoWrite', toolUseId: 'native-todo-1', toolResponse: {},
};

beforeEach(() => {
  previous = ENV.map(key => process.env[key]);
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.DO_NOT_TRACK;
  process.env.CLAUDE_MEM_SKIP_TOOLS = 'TodoWrite';
  process.env.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'false';
  process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
  __resetTelemetryForTests();
  telemetryBuffer.__resetForTests();
  postHogCaptureCalls.length = 0;
  store = new SessionStore(new Database(':memory:'));
  queue = mock(() => {});
  setIngestContext({
    sessionManager: { queueObservation: queue } as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
  });
});

afterEach(() => {
  store.close();
  ENV.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
  telemetryBuffer.__resetForTests();
  __resetTelemetryForTests();
});

function prompt(text: string) {
  const id = store.createSDKSession(payload.contentSessionId, 'telemetry-work', '', undefined, 'codex');
  store.saveUserPrompt(payload.contentSessionId, 1, text, id);
  recordWorkStatePrivacy(store.db, payload, !text.trim());
}

function rows() {
  telemetryBuffer.flush();
  return postHogCaptureCalls.filter(call => call.event === 'work_state_usage_rollup');
}

async function withRoutes(run: (port: number) => Promise<void>) {
  const routes = new SessionRoutes(
    { getSession: () => undefined, initializeSession: () => ({ project: 'telemetry-work' }) } as any,
    { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
    {} as any, {} as any, {} as any,
    { broadcastNewPrompt: () => {}, broadcastSessionStarted: () => {} } as any,
    {} as any, {} as any,
  );
  (routes as any).ensureGeneratorRunning = async () => {};
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run((server.address() as { port: number }).port); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('work-state capture boundary', () => {
  it('counts native todo use once even when that tool is excluded from memory generation', async () => {
    prompt('Do the work');
    expect(await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now() })).toMatchObject({ status: 'skipped', reason: 'tool_excluded' });
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now() });
    expect(rows()[0].properties).toMatchObject({ native_todo_count: 1, captured_tool_count: 1, instruction_state: 'unknown', agent_role: 'unknown' });
    expect(queue).not.toHaveBeenCalled();
    expect(store.queryToolUses({})).toHaveLength(0);
  });

  it('does not count entirely private or missing prompts', async () => {
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now() });
    expect(rows()).toHaveLength(0);
    prompt('');
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now() });
    expect(rows()).toHaveLength(0);
  });

  it('counts each missing-ID work-state event only once', async () => {
    prompt('Do the work');
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), toolName: 'work_state_write', toolUseId: undefined });
    expect(rows()[0].properties.unidentified_tool_event_count).toBe(1);
  });

  it('records captured usage through the normal prompt hook, observation hook, and spool drain', async () => {
    const temporary = useTempHookSpoolDataDir();
    const spool = new HookSpool();
    // Keep the real durable spool while avoiding a nudge to any external worker.
    const spoolSpy = spyOn(spoolHooks, 'spoolHookEvent').mockImplementation((kind: any, data: any) => spool.enqueue(kind, data));
    process.env.CLAUDE_MEM_SKIP_TOOLS = 'work_state_write';
    try {
      await withRoutes(async port => {
        setSessionInitDependenciesForTesting({
          shouldTrackProject: () => true,
          loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
          resolveRuntimeContext: () => ({ runtime: 'worker' }),
          isWorkerFallback: () => false,
          executeWithWorkerFallback: async (path: string, _method: string, body: unknown) => {
            const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return response.json();
          },
        });
        const input = { sessionId: 'normal-hook-path', cwd: temporary.dataDir, platform: 'codex', agentId: 'main-agent' };
        recordWorkStateInstruction(store.db, { contentSessionId: input.sessionId, platformSource: 'codex', agentId: input.agentId, enqueuedAtEpochMs: Date.now() - 10 }, 'returned', 'normal-context');
        await sessionInitHandler.execute({ ...input, prompt: 'Read and update the saved progress' });
        await observationHandler.execute({ ...input, toolName: 'work_state_write', toolUseId: 'normal-write', toolResponse: 'Saved to "progress" in project.' });
        await drainHookSpool(spool);
        const metrics = rows().map(row => row.properties);
        expect(metrics.some(row => row.captured_write_ok_count === 1 && row.platform === 'codex' && row.agent_role === 'main')).toBe(true);
        expect(metrics.some(row => row.captured_prompt_count === 1 && row.instruction_state === 'returned')).toBe(true);
        expect(queue).not.toHaveBeenCalled();
      });
    } finally {
      setSessionInitDependenciesForTesting();
      spoolSpy.mockRestore();
      temporary.restore();
    }
  });

  it('keeps public/private/public boundaries through real init and post-tool routes', async () => {
    await withRoutes(async port => {
      const post = async (path: string, body: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const base = { contentSessionId: payload.contentSessionId, platformSource: 'codex', project: 'telemetry-work', agentId: 'main-agent' };
      const tool = async (toolName: string, id: string, at = Date.now()) => post('observations', {
        ...base, tool_name: toolName, tool_response: 'Saved to "list" in project.', tool_use_id: id, enqueuedAtEpochMs: at,
      });
      await post('init', { ...base, prompt: 'First public request' });
      await tool('TodoWrite', 'public-1');
      await post('init', { ...base, prompt: '<private>never store this private turn</private>' });
      const privateAt = Date.now();
      await tool('TodoWrite', 'private-native');
      await tool('work_state_write', 'private-write');
      await tool('Read', 'private-read');
      await new Promise(resolve => setTimeout(resolve, 2));
      await post('init', { ...base, prompt: 'Second public request' });
      await tool('TodoWrite', 'delayed-private', privateAt);
      await tool('TodoWrite', 'public-2');
      const metrics = rows().map(row => row.properties);
      expect(metrics.reduce((n, r) => n + Number(r.native_todo_count ?? 0), 0)).toBe(2);
      expect(metrics.reduce((n, r) => n + Number(r.captured_write_count ?? 0), 0)).toBe(0);
      expect(metrics.reduce((n, r) => n + Number(r.captured_tool_count ?? 0), 0)).toBe(2);
      expect(metrics.find(r => r.captured_prompt_count)?.agent_role).toBe('main');
      expect(store.db.query('SELECT COUNT(*) AS n FROM user_prompts').get()).toEqual({ n: 2 });
      expect(JSON.stringify(store.db.query('SELECT * FROM work_state_telemetry_receipts').all())).not.toContain('never store');
    });
  });

  it('does not count missing-prompt writes or ordinary tools through the normal ingestion path', async () => {
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), toolName: 'work_state_write', toolUseId: 'missing-write', toolResponse: 'Saved to "a" in project.' });
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), toolName: 'Read', toolUseId: 'missing-read' });
    expect(queue).toHaveBeenCalledTimes(2); // existing observation behavior survives
    expect(rows()).toHaveLength(0); // telemetry needs affirmative public-prompt evidence
  });

  it('preserves unknown telemetry host despite the legacy Claude database default', async () => {
    const id = store.createSDKSession(payload.contentSessionId, 'telemetry-work', '', undefined, 'claude');
    store.saveUserPrompt(payload.contentSessionId, 1, 'Do the work', id);
    recordWorkStatePrivacy(store.db, { ...payload, platformSource: undefined }, false);
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), platformSource: undefined });
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), toolUseId: 'legacy-normalized', platformSource: 'claude', telemetryPlatformSource: 'unknown' });
    expect(rows()[0].properties).toMatchObject({ platform: 'unknown', native_todo_count: 2 });
  });

  it('preserves unknown host through the real session-init HTTP route', async () => {
    await withRoutes(async port => {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId: 'raw-http-no-host', project: 'telemetry-work', prompt: 'Read saved work state' }),
      });
      expect(await response.json()).toMatchObject({ status: 'initialized' });
      expect(response.status).toBe(200);
      expect(rows()[0].properties).toMatchObject({ platform: 'unknown', captured_prompt_count: 1 });
      expect(store.db.query('SELECT platform_source FROM sdk_sessions WHERE content_session_id = ?').get('raw-http-no-host')).toEqual({ platform_source: 'claude' });
    });
  });

  it('does not count excluded projects or excluded subagents', async () => {
    prompt('Do the work');
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '/tmp/telemetry-work';
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now() });
    expect(rows()).toHaveLength(0);
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
    process.env.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), agentId: 'agent', agentType: 'Explore' });
    expect(rows()).toHaveLength(0);
  });

  it('counts real host failure receipts without forwarding their error text', async () => {
    prompt('Do the work');
    await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now(), toolName: 'mcp__mcp_search__work_state_write', toolResponse: { error: 'Error executing tool: secret failure', is_interrupt: false } });
    expect(rows()[0].properties).toMatchObject({ captured_write_count: 1, captured_write_error_count: 1 });
    expect(JSON.stringify(rows())).not.toContain('secret');
  });

  it('keeps an excluded tool harmless when the telemetry lookup cannot reach the database', async () => {
    setIngestContext({ sessionManager: {} as any, dbManager: { getSessionStore: () => { throw new Error('offline'); } } as any, eventBroadcaster: {} as any });
    expect(await ingestObservation({ ...payload, enqueuedAtEpochMs: Date.now() })).toMatchObject({ status: 'skipped', reason: 'tool_excluded' });
  });
});

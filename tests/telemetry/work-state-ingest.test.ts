import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared';
import { telemetryBuffer } from '../../src/services/telemetry/buffer';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';
import { postHogCaptureCalls } from '../preload';

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
}

function rows() {
  telemetryBuffer.flush();
  return postHogCaptureCalls.filter(call => call.event === 'work_state_usage_rollup');
}

describe('work-state capture boundary', () => {
  it('counts native todo use once even when that tool is excluded from memory generation', async () => {
    prompt('Do the work');
    expect(await ingestObservation(payload)).toMatchObject({ status: 'skipped', reason: 'tool_excluded' });
    await ingestObservation(payload);
    expect(rows()[0].properties).toMatchObject({ native_todo_count: 1, captured_tool_count: 1, instruction_state: 'unknown', agent_role: 'unknown' });
    expect(queue).not.toHaveBeenCalled();
    expect(store.queryToolUses({})).toHaveLength(0);
  });

  it('does not count entirely private or missing prompts', async () => {
    await ingestObservation(payload);
    expect(rows()).toHaveLength(0);
    prompt('');
    await ingestObservation(payload);
    expect(rows()).toHaveLength(0);
  });

  it('does not count excluded projects or excluded subagents', async () => {
    prompt('Do the work');
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '/tmp/telemetry-work';
    await ingestObservation(payload);
    expect(rows()).toHaveLength(0);
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
    process.env.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    await ingestObservation({ ...payload, agentId: 'agent', agentType: 'Explore' });
    expect(rows()).toHaveLength(0);
  });

  it('counts real host failure receipts without forwarding their error text', async () => {
    prompt('Do the work');
    await ingestObservation({ ...payload, toolName: 'mcp__mcp_search__work_state_write', toolResponse: { error: 'Error executing tool: secret failure', is_interrupt: false } });
    expect(rows()[0].properties).toMatchObject({ captured_write_count: 1, captured_write_error_count: 1 });
    expect(JSON.stringify(rows())).not.toContain('secret');
  });

  it('keeps an excluded tool harmless when the telemetry lookup cannot reach the database', async () => {
    setIngestContext({ sessionManager: {} as any, dbManager: { getSessionStore: () => { throw new Error('offline'); } } as any, eventBroadcaster: {} as any });
    expect(await ingestObservation(payload)).toMatchObject({ status: 'skipped', reason: 'tool_excluded' });
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const nudgeLog: string[] = [];
let useServerRuntime = false;

mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  workerHttpRequest: (path: string) => {
    nudgeLog.push(path);
    return Promise.resolve(new Response('{"status":"draining"}', { status: 202 }));
  },
}));
mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => useServerRuntime ? { runtime: 'server', projectId: 'p', serverBaseUrl: 'http://server.test', client: {} } : { runtime: 'worker' },
}));

import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { setIngestContext } from '../../../src/services/worker/http/shared.js';
import { drainHookSpool } from '../../../src/services/worker/hook-spool-drain.js';
import { HookSpool } from '../../../src/shared/hook-spool.js';
import { remoteSpoolEnvelopeSchema } from '../../../src/shared/hook-spool-remote.js';
import { reduceWorkState } from '../../../src/services/work-view/data-source.mjs';
import { AGENT_LIFECYCLE_LIST, readAgentStops, agentStopFor } from '../../../src/services/work-view/agent-lifecycle.mjs';
import { logger } from '../../../src/utils/logger.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

// The SubagentStop input Claude Code documents (code.claude.com/docs/en/hooks).
const SUBAGENT_STOP_INPUT = {
  session_id: 'parent-session',
  transcript_path: '~/.claude/projects/repo/parent-session.jsonl',
  cwd: '/tmp/subagent-stop-project',
  permission_mode: 'default',
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id: 'a1e7d1aa9fa57892a',
  agent_type: 'general-purpose',
  agent_transcript_path: '~/.claude/projects/repo/parent-session/subagents/agent-a1e7d1aa9fa57892a.jsonl',
  last_assistant_message: 'All phases built and verified.',
  background_tasks: [],
  session_crons: [],
};

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  nudgeLog.length = 0;
  useServerRuntime = false;
  loggerSpies = ['debug', 'warn', 'info', 'error'].map(level => spyOn(logger, level as 'debug').mockImplementation(() => {}));
});
afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
});
afterAll(() => {
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('SubagentStop hook', () => {
  it('spools the subagent identity and nudges the worker, keeping no transcript text', async () => {
    const input = claudeCodeAdapter.normalizeInput(SUBAGENT_STOP_INPUT);
    input.platform = 'claude-code';
    const result = await getEventHandler('subagent-stop').execute(input);
    expect(result).toMatchObject({ continue: true, suppressOutput: true });
    expect(nudgeLog).toEqual(['/api/spool/nudge']);
    expect(spooledEntries()).toEqual([{
      kind: 'subagent_stop',
      payload: { contentSessionId: 'parent-session', platformSource: 'claude', agentId: 'a1e7d1aa9fa57892a', agentType: 'general-purpose', cwd: '/tmp/subagent-stop-project' },
      enqueuedAtEpochMs: expect.any(Number),
    }]);
  });

  it('skips a stop with no agent id', async () => {
    const input = claudeCodeAdapter.normalizeInput({ ...SUBAGENT_STOP_INPUT, agent_id: undefined });
    await getEventHandler('subagent-stop').execute(input);
    expect(spooledEntries()).toEqual([]);
  });

  it('accepts the entry over the remote spool protocol', () => {
    const parsed = remoteSpoolEnvelopeSchema.safeParse({ protocolVersion: 1, entry: {
      kind: 'subagent_stop', enqueuedAtEpochMs: 1,
      payload: { contentSessionId: 's', platformSource: 'claude', agentId: 'a1' },
    } });
    expect(parsed.success).toBe(true);
  });
});

describe('subagent_stop drain', () => {
  let spoolDir: string;
  let store: SessionStore;
  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), 'claude-mem-subagent-stop-'));
    store = new SessionStore(new Database(':memory:'));
    setIngestContext({ sessionManager: {} as any, dbManager: { getSessionStore: () => store } as any, eventBroadcaster: {} as any, ensureGeneratorRunning: async () => {} });
  });
  afterEach(() => {
    store.close();
    rmSync(spoolDir, { recursive: true, force: true });
  });

  it('saves one closed agent-lifecycle row stamped with the hook time', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    const before = Date.now();
    spool.enqueue('subagent_stop', { contentSessionId: 'parent-session', platformSource: 'claude', agentId: 'a1e7d1aa9fa57892a', agentType: 'general-purpose', cwd: '/tmp/subagent-stop-project' });
    const after = Date.now();
    const result = await drainHookSpool(spool);
    expect(result.drained).toBe(1);
    const rows = store.db.prepare('SELECT project, list_name, fields, created_at_epoch FROM work_state_entries').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].list_name).toBe(AGENT_LIFECYCLE_LIST);
    const fields = JSON.parse(rows[0].fields);
    expect(fields).toMatchObject({ status: 'done', agent_id: 'a1e7d1aa9fa57892a', content_session_id: 'parent-session', platform_source: 'claude', stop_source: 'subagent-stop-hook', agent_type: 'general-purpose' });
    expect(fields.stopped_at_epoch).toBe(rows[0].created_at_epoch);
    expect(fields.stopped_at_epoch).toBeGreaterThanOrEqual(before);
    expect(fields.stopped_at_epoch).toBeLessThanOrEqual(after);
    const state = reduceWorkState(rows.map((row, index) => ({ id: index + 1, ...row })), { currentProject: rows[0].project });
    expect(agentStopFor(readAgentStops(state), 'claude', 'parent-session', 'a1e7d1aa9fa57892a')?.stoppedAtEpoch).toBe(fields.stopped_at_epoch);
  });
});

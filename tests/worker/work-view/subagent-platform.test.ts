import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { upsertToolUse } from '../../../src/services/sqlite/tool-uses.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';
import { publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { applySharedProjection, buildSharedProjectionUpdates, isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';

const NOW = Date.now();
const CONTENT = 'same-content-id';
const AGENT = 'same-agent-id';
const databases: Database[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

function store() {
  const database = new Database(':memory:');
  databases.push(database);
  return new SessionStore(database);
}

function state(store: SessionStore, deviceId: string) {
  const entries = store.db.query('SELECT * FROM work_state_entries').all();
  return reduceWorkState(entries, { currentProject: 'repo', currentProjectScope: ['repo'], localDeviceId: deviceId });
}

function fixture(asyncClaude: boolean, activityPlatform?: string) {
  const source = store();
  for (const platform of ['claude', 'codex']) {
    const sessionDbId = source.createSDKSession(CONTENT, 'repo', `Work in ${platform}`, undefined, platform);
    const memorySessionId = `memory-${platform}`;
    source.updateMemorySessionId(sessionDbId, memorySessionId);
    const context = { contentSessionId: CONTENT, sessionDbId, memorySessionId, project: 'repo', platformSource: platform };
    const fields = { task: `${platform} task`, status: 'doing' };
    source.appendWorkStateEntry({ project: 'repo', listName: platform, fields, createdAtEpoch: NOW - 500 });
    upsertToolUse(source.db, { ...context, toolUseId: `work-${platform}`, agentId: AGENT, toolName: 'work_state_write',
      toolInput: JSON.stringify({ list: platform, fields }), createdAtEpoch: NOW - 500 });
    if (platform === 'claude' || asyncClaude) {
      upsertToolUse(source.db, { ...context, toolUseId: `launch-${platform}`, toolName: 'Agent',
        toolInput: JSON.stringify({ description: `${platform} task` }),
        toolResponse: JSON.stringify({ agentId: AGENT, status: platform === 'claude' && asyncClaude ? 'async_launched' : 'completed', isAsync: platform === 'claude' && asyncClaude }),
        createdAtEpoch: NOW - (platform === 'claude' ? 200 : 100) });
    }
    if (activityPlatform === platform) upsertToolUse(source.db, { ...context, toolUseId: `read-${platform}`, agentId: AGENT,
      toolName: 'Read', toolInput: JSON.stringify({ file_path: 'README.md' }), createdAtEpoch: NOW });
  }
  return source;
}

function view(source: SessionStore, replica: boolean) {
  const sourceState = state(source, 'a');
  const records = readAgentRecords(source.db, { workState: sourceState, now: NOW });
  const sourceView = buildAgentView(sourceState, records, { now: NOW });
  if (!replica) return sourceView;

  const receiver = store();
  receiver.appendWorkStateEntry({ project: 'padding', listName: 'different-local-id', fields: {} });
  const updates = buildSharedProjectionUpdates(source.db, { records, view: sourceView, deviceId: 'a' });
  publishSharedRecords(source.db, { deviceId: 'a', project: 'repo', updates, validateValue: isSharedProjectionValue });
  const rows = source.db.query('SELECT * FROM work_state_entries ORDER BY id').all() as any[];
  const operations = rows.map((row, index) => ({ seq: String(index + 1), ...buildContentOperation({
    kind: 'work_state', originDeviceId: 'a', originLocalId: String(row.id), entityRev: row.sync_rev,
    payload: { created_at: row.created_at, created_at_epoch: String(row.created_at_epoch), project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields) },
  }) }));
  new SyncApply(receiver.db, { deviceId: 'b' }).applyOps(decodeChanges(operations), { epoch: '1' });
  const receivedState = state(receiver, 'b');
  const shared = readSharedRecords(receiver.db, { deviceId: 'b', validateValue: isSharedProjectionValue });
  expect(shared.diagnostics.invalid).toBe(0);
  const merged = applySharedProjection(receiver.db, shared, {
    records: readAgentRecords(receiver.db, { workState: receivedState, now: NOW }), deviceId: 'b',
  });
  expect(receiver.db.query('SELECT COUNT(*) AS n FROM tool_uses').get()).toEqual({ n: 0 });
  return buildAgentView(receivedState, merged.records, { ledger: merged.ledger, now: NOW });
}

for (const replica of [false, true]) {
  const location = replica ? 'canonical replica' : 'native reader';
  test(`${location}: another platform's returned launch does not finish a Claude subagent`, () => {
    const result = view(fixture(true), replica);
    const claude = result.agents.find((agent: any) => agent.platformSource === 'claude' && agent.agentId === AGENT);
    expect(claude.presence.status).not.toBe('finished');
    expect(claude.launch.description).toBe('claude task');
    expect(claude.canMarkFinished).toBe(true);
  });

  test(`${location}: another platform's tool activity does not resume a finished Claude subagent`, () => {
    const result = view(fixture(false, 'codex'), replica);
    const claude = result.agents.find((agent: any) => agent.platformSource === 'claude' && agent.agentId === AGENT);
    expect(claude.presence.status).toBe('finished');
    expect(claude.presence.evidence).toBe('agent-call-returned');
    expect(claude.canMarkFinished).toBe(false);
  });

  test(`${location}: the subagent's own later tool call still resumes it`, () => {
    const result = view(fixture(false, 'claude'), replica);
    const claude = result.agents.find((agent: any) => agent.platformSource === 'claude' && agent.agentId === AGENT);
    expect(claude.presence.status).not.toBe('finished');
    expect(claude.canMarkFinished).toBe(true);
  });
}

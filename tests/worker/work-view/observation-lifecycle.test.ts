import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { upsertToolUse } from '../../../src/services/sqlite/tool-uses.js';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';
import { AGENT_LIFECYCLE_LIST, agentStopFields } from '../../../src/services/work-view/agent-lifecycle.mjs';

const NOW = Date.now();
const CONTENT = 'observation-only-parent';
const MEMORY = 'observation-only-memory';
const AGENT = 'observation-only-child';
const databases: Database[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

function fixture(legacyContentColumn: boolean, resumed: boolean) {
  const database = new Database(':memory:');
  databases.push(database);
  const store = new SessionStore(database);
  expect(database.query('PRAGMA table_info(observations)').all().some((row: any) => row.name === 'content_session_id')).toBe(false);
  const sessionDbId = store.createSDKSession(CONTENT, 'repo', 'Check the release', undefined, 'claude');
  store.updateMemorySessionId(sessionDbId, MEMORY);
  store.saveUserPrompt(CONTENT, 1, 'Check the release', sessionDbId);
  store.storeObservation(MEMORY, 'repo', {
    type: 'discovery', title: 'Checked the release', subtitle: null, narrative: 'The release was checked.',
    facts: [], concepts: [], files_read: [], files_modified: [], agent_id: AGENT, agent_type: 'general-purpose',
  }, 1, 0, NOW - 500);
  if (legacyContentColumn) {
    database.exec('ALTER TABLE observations ADD COLUMN content_session_id TEXT');
    database.query('UPDATE observations SET content_session_id = ?').run(CONTENT);
  }
  const context = { contentSessionId: CONTENT, sessionDbId, memorySessionId: MEMORY, project: 'repo', platformSource: 'claude' };
  upsertToolUse(database, { ...context, toolUseId: 'launch', toolName: 'Agent', promptNumber: 1,
    toolInput: JSON.stringify({ description: 'Check release signatures' }),
    toolResponse: JSON.stringify({ agentId: AGENT, status: resumed ? 'async_launched' : 'completed', isAsync: resumed }),
    createdAtEpoch: NOW - 200 });
  if (resumed) {
    store.appendWorkStateEntry({ project: 'repo', listName: AGENT_LIFECYCLE_LIST, createdAtEpoch: NOW - 200,
      fields: agentStopFields({ platformSource: 'claude', contentSessionId: CONTENT, agentId: AGENT, stoppedAtEpoch: NOW - 200, stopSource: 'subagent-stop-hook' }) });
    upsertToolUse(database, { ...context, toolUseId: 'read-after-stop', agentId: AGENT, toolName: 'Read',
      toolInput: JSON.stringify({ file_path: 'signatures.txt' }), createdAtEpoch: NOW - 100 });
  }
  const state = reduceWorkState(database.query('SELECT * FROM work_state_entries').all(), { currentProject: 'repo', currentProjectScope: ['repo'] });
  const records = readAgentRecords(database, { workState: state, now: NOW });
  expect(records.calls).toHaveLength(0); // No work_state_write should be needed to discover lifecycle evidence.
  const view = buildAgentView(state, records, { now: NOW });
  return view.agents.find((agent: any) => agent.agentId === AGENT);
}

for (const legacyContentColumn of [false, true]) {
  const schema = legacyContentColumn ? 'legacy observation content column' : 'current observation schema';
  test(`${schema}: an observation-only subagent uses its recorded task and foreground finish`, () => {
    const agent = fixture(legacyContentColumn, false);
    expect(agent.presence.status).toBe('finished');
    expect(agent.presence.evidence).toBe('agent-call-returned');
    expect(agent.work[0].request.text).toBe('Check release signatures');
    expect(agent.work[0].isOpen).toBe(false);
  });

  test(`${schema}: a later tool call resumes an observation-only stopped subagent`, () => {
    const agent = fixture(legacyContentColumn, true);
    expect(agent.presence.status).not.toBe('finished');
    expect(agent.work[0].request.text).toBe('Check release signatures');
    expect(agent.canMarkFinished).toBe(true);
  });
}

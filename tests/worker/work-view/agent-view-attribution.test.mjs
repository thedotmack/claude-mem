import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentView } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/data-source.mjs';

const NOW = Date.parse('2026-10-17T16:00:00Z');
const session = {
  id: 3, project: 'repo/tree', platform_source: 'codex',
  memory_session_id: 'memory-three', content_session_id: 'session-three',
  status: 'active', started_at_epoch: NOW - 600000,
};
const first = { task: 'Build the local viewer', status: 'doing', progress: 'Started the viewer.' };
const entry = (id, fields, at) => ({ id, project: 'repo/tree', list_name: 'viewer', fields: JSON.stringify(fields), created_at_epoch: at });
const call = (id, fields, at) => ({
  id, project: 'repo/tree', platform_source: 'codex', agent_id: null, agent_type: 'main',
  session_db_id: session.id, memory_session_id: session.memory_session_id, content_session_id: session.content_session_id,
  prompt_number: 1, tool_input: JSON.stringify({ list: 'viewer', fields }), created_at_epoch: at,
});
const viewFor = (entries, calls) => buildAgentView(
  reduceWorkState(entries, { currentProject: 'repo/tree', currentProjectScope: ['repo/tree'] }),
  { sessions: [session], calls }, { now: NOW },
);
const taskRow = (view) => view.agents.flatMap((agent) => agent.work.map((work) => ({ agent, work })))
  .find(({ work }) => work.title === 'Build the local viewer');

test('a newer update without a captured call keeps the agent who did the work', () => {
  const later = { task: 'Build the local viewer', progress: 'A new saved update arrived.' };
  const view = viewFor(
    [entry(1, first, NOW - 120000), entry(2, later, NOW - 1000)],
    [call(10, first, NOW - 120000)],
  );
  const { agent, work } = taskRow(view);
  assert.equal(agent.label, 'Codex');
  assert.notEqual(agent.kind, 'unassigned');
  assert.equal(work.attribution.meaning, 'latest-linked-update-author');
  assert.equal(work.attribution.linkedEntryId, 1);
  assert.equal(work.progress.text, 'A new saved update arrived.');
  assert.equal(view.coverage.unattributedWork, 0);
});

test('a newest update that links directly is still credited as the update author', () => {
  const later = { task: 'Build the local viewer', progress: 'Finished the layout.' };
  const view = viewFor(
    [entry(1, first, NOW - 120000), entry(2, later, NOW - 1000)],
    [call(10, first, NOW - 120000), call(11, later, NOW - 1000)],
  );
  const { work } = taskRow(view);
  assert.equal(work.attribution.meaning, 'update-author');
  assert.equal(work.attribution.toolUseId, 11);
});

test('work with no linked write anywhere is still shown as unassigned', () => {
  const view = viewFor([entry(1, first, NOW - 120000)], []);
  const { agent } = taskRow(view);
  assert.equal(agent.label, 'Unassigned work');
});

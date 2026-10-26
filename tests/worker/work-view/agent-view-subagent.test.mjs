import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentView } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/data-source.mjs';
import { AGENT_LIFECYCLE_LIST, agentStopFields } from '../../../src/services/work-view/agent-lifecycle.mjs';

// One Claude Code conversation: the coordinator (no agent id) and an async
// subagent it launched at prompt 2, both writing into the same session.
const NOW = Date.parse('2026-10-23T20:00:00Z');
const MIN = 60_000;
const SUB = 'a1e7d1aa9fa57892a';
const session = {
  id: 150797, project: 'repo', platform_source: 'claude', content_session_id: 'parent-session',
  memory_session_id: 'memory-parent', user_prompt: 'Build the install funnel', status: 'active', started_at_epoch: NOW - 600 * MIN,
};
const prompts = [2, 3, 4, 5].map((number) => ({
  id: 900 + number, session_db_id: session.id, prompt_number: number,
  prompt_text: `Please fix coordinator request number ${number}`, created_at_epoch: NOW - (500 - number * 10) * MIN,
}));
let nextObservation = 1;
const observation = (agentId, promptNumber, atEpoch, title = `Step ${nextObservation}`) => ({
  id: nextObservation++, project: 'repo', memory_session_id: session.memory_session_id, content_session_id: session.content_session_id,
  agent_id: agentId, agent_type: agentId ? 'general-purpose' : null, prompt_number: promptNumber, title, subtitle: null, type: 'change', created_at_epoch: atEpoch,
});
// Rows as readAgentRecords returns them (fields pulled out of the JSON in SQL).
const asyncLaunch = {
  id: 180321, session_db_id: session.id, content_session_id: session.content_session_id, platform_source: 'claude', prompt_number: 2,
  agent_id: SUB, status: 'async_launched', is_async: 1,
  description: 'Build install funnel phases 4-11', prompt: 'You are executing the remaining phases',
  created_at_epoch: NOW - 470 * MIN,
};
const baseObservations = () => [
  observation(null, 2, NOW - 465 * MIN, 'Coordinator planned the phases'),
  observation(null, 3, NOW - 400 * MIN, 'Coordinator answered request 3'),
  observation(null, 4, NOW - 300 * MIN, 'Coordinator answered request 4'),
  observation(null, 5, NOW - 200 * MIN, 'Coordinator answered request 5'),
  // The subagent kept working while the parent moved through prompts 3-5.
  observation(SUB, 2, NOW - 460 * MIN, 'Built phase 4'),
  observation(SUB, 3, NOW - 390 * MIN, 'Built phase 7'),
  observation(SUB, 4, NOW - 290 * MIN, 'Built phase 9'),
  observation(SUB, 5, NOW - 120 * MIN, 'Captured a Reveal screenshot'),
];
const stopEntry = (id, atEpoch, stopSource = 'subagent-stop-hook') => ({
  id, project: 'repo', list_name: AGENT_LIFECYCLE_LIST, created_at_epoch: atEpoch,
  fields: JSON.stringify(agentStopFields({ platformSource: 'claude', contentSessionId: session.content_session_id, agentId: SUB, agentType: 'general-purpose', stoppedAtEpoch: atEpoch, stopSource })),
});
function viewFor({ entries = [], observations = baseObservations(), launches = [asyncLaunch], toolActivity = [] } = {}) {
  return buildAgentView(
    reduceWorkState(entries, { currentProject: 'repo', currentProjectScope: ['repo'] }),
    { sessions: [session], prompts, observations, agentLaunches: launches, agentToolActivity: toolActivity },
    { now: NOW },
  );
}
const subagentOf = (view) => view.agents.find((agent) => agent.agentId === SUB);
const mainOf = (view) => view.agents.find((agent) => agent.sessionId === session.id && agent.agentId === null);

test('without a recorded stop, an async subagent is not called finished, however long it has been quiet', () => {
  const sub = subagentOf(viewFor());
  assert.equal(sub.isSubagent, true);
  assert.notEqual(sub.presence.status, 'finished');
  assert.equal(sub.canMarkFinished, true);
  assert.ok(sub.work.every((item) => item.isOpen));
});

test('a recorded SubagentStop makes the subagent finished and closes its rows', () => {
  const view = viewFor({ entries: [stopEntry(1, NOW - 110 * MIN)] });
  const sub = subagentOf(view);
  assert.equal(sub.presence.status, 'finished');
  assert.equal(sub.presence.evidence, 'subagent-stop-hook');
  assert.equal(sub.presence.finishedAt, new Date(NOW - 110 * MIN).toISOString());
  assert.equal(sub.canMarkFinished, false);
  assert.ok(sub.work.length > 0);
  assert.ok(sub.work.every((item) => !item.isOpen && item.status === 'finished'));
  assert.equal(sub.counts.open, 0);
  // The stop row is lifecycle evidence, never a work card of its own.
  assert.ok(view.agents.every((agent) => agent.work.every((item) => item.listName !== AGENT_LIFECYCLE_LIST)));
});

test('the owner marking a subagent finished counts as a recorded stop', () => {
  const sub = subagentOf(viewFor({ entries: [stopEntry(1, NOW - 5 * MIN, 'owner-marked-finished')] }));
  assert.equal(sub.presence.status, 'finished');
  assert.equal(sub.presence.evidence, 'owner-marked-finished');
});

test('an observation after the stop means the subagent resumed', () => {
  const observations = [...baseObservations(), observation(SUB, 5, NOW - 60 * MIN, 'Resumed and fixed the screenshot')];
  const sub = subagentOf(viewFor({ entries: [stopEntry(1, NOW - 110 * MIN)], observations }));
  assert.notEqual(sub.presence.status, 'finished');
  assert.equal(sub.canMarkFinished, true);
  assert.ok(sub.work.every((item) => item.isOpen));
});

test('a captured tool call after the stop also means the subagent resumed', () => {
  const toolActivity = [{ content_session_id: session.content_session_id, agent_id: SUB, last_epoch: NOW - 100 * MIN }];
  const sub = subagentOf(viewFor({ entries: [stopEntry(1, NOW - 110 * MIN)], toolActivity }));
  assert.notEqual(sub.presence.status, 'finished');
});

test('a foreground Agent call that returned is a recorded finish without any stop row', () => {
  const foreground = {
    ...asyncLaunch, created_at_epoch: NOW - 100 * MIN, status: 'completed', is_async: null,
  };
  const sub = subagentOf(viewFor({ launches: [foreground] }));
  assert.equal(sub.presence.status, 'finished');
  assert.equal(sub.presence.evidence, 'agent-call-returned');
  assert.deepEqual(sub.presence.sourceRef, { kind: 'tool-use', id: asyncLaunch.id });
});

test("the parent's requests stay with the main agent; the subagent holds only its own launched task", () => {
  const view = viewFor();
  const sub = subagentOf(view), main = mainOf(view);
  assert.equal(sub.work.length, 1);
  assert.equal(sub.work[0].request.text, 'Build install funnel phases 4-11');
  assert.equal(sub.work[0].request.source, 'agent-launch');
  assert.equal(sub.work[0].request.key, JSON.stringify(['request', 'claude', String(session.id), 2]));
  assert.ok(sub.work.every((item) => !/coordinator request/i.test(item.request.text)));
  const mainRequests = main.work.map((item) => item.request.text);
  for (const number of [2, 3, 4, 5]) assert.ok(mainRequests.includes(`Please fix coordinator request number ${number}`), `request ${number} under main`);
  // The conversation's request card names the main agent even though the subagent was active last.
  const request = view.humanRequests.find((item) => item.conversationKey === JSON.stringify(['conversation', 'claude', session.content_session_id]));
  assert.equal(request.agentIds[0], main.id);
});

test("a parent prompt whose only observations came from a subagent still shows as the main agent's row", () => {
  // Prompt 6: the owner asked something, and only the subagent recorded anything during it.
  const ownerAsk = { id: 906, session_db_id: session.id, prompt_number: 6, prompt_text: 'Please publish the install page as an artifact', created_at_epoch: NOW - 150 * MIN };
  const subagentOnly = observation(SUB, 6, NOW - 140 * MIN, 'Published the install page');
  const view = buildAgentView(
    reduceWorkState([], { currentProject: 'repo', currentProjectScope: ['repo'] }),
    { sessions: [session], prompts: [...prompts, ownerAsk], observations: [...baseObservations(), subagentOnly], agentLaunches: [asyncLaunch], agentToolActivity: [] },
    { now: NOW },
  );
  const main = mainOf(view), sub = subagentOf(view);
  const row = main.work.find((item) => item.request.text === 'Please publish the install page as an artifact');
  assert.ok(row, 'the owner ask is a row under the main agent');
  assert.equal(row.request.key, JSON.stringify(['request', 'claude', String(session.id), 6]));
  assert.equal(row.attribution.meaning, 'recorded-session');
  assert.ok(row.sourceRefs.some((ref) => ref.kind === 'observation' && ref.id === subagentOnly.id), "the subagent's observation is the row's evidence");
  // The subagent still holds only its launched task.
  assert.equal(sub.work.length, 1);
  assert.ok(sub.activity.some((entry) => entry.id === `observation:${subagentOnly.id}`));
});

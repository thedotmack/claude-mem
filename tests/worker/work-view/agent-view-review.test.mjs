import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentView } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/data-source.mjs';

const NOW = Date.parse('2026-10-15T18:00:00Z');
const emptyState = () => reduceWorkState([], {
  currentProject: 'repo/tree', currentProjectScope: ['repo/tree'],
});
const session = {
  id: 7, project: 'repo/tree', platform_source: 'codex',
  memory_session_id: 'memory-seven', content_session_id: 'session-seven',
  status: 'active', started_at_epoch: NOW - 60000,
};
const observation = (id, overrides = {}) => ({
  id, project: 'repo/tree', memory_session_id: 'memory-seven',
  content_session_id: 'session-seven', agent_id: null, agent_type: null,
  prompt_number: 2, title: 'Importer validation remains open',
  created_at_epoch: NOW - id * 1000, ...overrides,
});

test('ending a recorded session does not mark its unfinished human request done', () => {
  const view = buildAgentView(emptyState(), {
    sessions: [{ ...session, status: 'completed', completed_at_epoch: NOW }],
    observations: [observation(1)],
    summaries: [{
      id: 10, memory_session_id: session.memory_session_id, prompt_number: 2,
      request: 'Import my existing memory history.',
      completed: 'Prepared the import adapter.',
      next_steps: 'Validate and run the full history import.', created_at_epoch: NOW,
    }],
  }, { now: NOW });
  const row = view.agents[0].work[0];
  assert.equal(row.status, 'unknown');
  assert.equal(row.isOpen, true);
  assert.match(row.nextStep.text, /full history import/);
  assert.equal(view.agents[0].presence.isLive, null);
});

test('a readable matching request summary outranks a raw prompt full of runtime wrappers', () => {
  const readable = 'Make the current work visible in a local tracker.';
  const view = buildAgentView(emptyState(), {
    sessions: [session], observations: [observation(1)],
    prompts: [{
      id: 11, session_db_id: session.id, prompt_number: 2,
      prompt_text: '# AGENTS.md instructions\n<INSTRUCTIONS>Internal workspace instructions.</INSTRUCTIONS>\n<environment_context>Runtime metadata.</environment_context>',
    }],
    summaries: [{
      id: 12, memory_session_id: session.memory_session_id, prompt_number: 2,
      request: readable, next_steps: 'Finish the source links.', created_at_epoch: NOW,
    }],
  }, { now: NOW });
  const row = view.agents[0].work[0];
  assert.equal(row.request.text, readable);
  assert.equal(row.request.source, 'session-summary-request');
  assert.equal(row.request.sourceId, 12);
});

test('a wrapper-only recorded prompt is not presented as the human request', () => {
  const view = buildAgentView(emptyState(), {
    sessions: [session], observations: [observation(1)],
    prompts: [{
      id: 11, session_db_id: session.id, prompt_number: 2,
      prompt_text: '<environment_context>\n<cwd>/private/workspace</cwd>\n<shell>zsh</shell>\n</environment_context>',
    }],
  }, { now: NOW });
  const row = view.agents[0].work[0];
  assert.doesNotMatch(row.request.text, /environment_context|<cwd>|<shell>/);
  assert.equal(row.request.source, 'observation-title');
});

test('unresolved sessions with the same prompt number keep their requests separate', () => {
  const view = buildAgentView(emptyState(), {
    observations: [
      observation(1, { memory_session_id: 'missing-session-a', content_session_id: 'a', title: 'Website release validation' }),
      observation(2, { memory_session_id: 'missing-session-b', content_session_id: 'b', title: 'Memory import validation' }),
    ],
  }, { now: NOW });
  const rows = view.agents.flatMap(agent => agent.work);
  assert.equal(rows.length, 2, 'unrelated source sessions must not collapse into one request');
  assert.deepEqual(rows.map(row => row.title).sort(), ['Memory import validation', 'Website release validation']);
});

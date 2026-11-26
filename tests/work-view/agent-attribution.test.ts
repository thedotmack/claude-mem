import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildAgentView, readAgentRecords } from '../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import { buildHumanRequests } from '../../src/services/work-view/request-projection.mjs';
import { groupIdFor } from '../../src/services/work-view/request-groups.mjs';

// Issue #6505: a request's card is built from its session's prompts, but its
// agent group was built only from recorded work and recent observations. A
// session that ended — prompts and a summary captured, observations aged out
// of the loaded window, no work state — left the card with agentIds: [] and
// the UI's "Agent not recorded" fallback.
const DAY = 86400000, NOW = 100 * DAY;
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, custom_title TEXT, status TEXT, started_at_epoch INTEGER, completed_at_epoch INTEGER, cwd TEXT);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, agent_id TEXT, agent_type TEXT, session_db_id INTEGER, memory_session_id TEXT, content_session_id TEXT, prompt_number INTEGER, tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, agent_id TEXT, agent_type TEXT, prompt_number INTEGER, title TEXT, subtitle TEXT, type TEXT, created_at_epoch INTEGER);
    CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, prompt_number INTEGER, request TEXT, completed TEXT, next_steps TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  return db;
}
const addSession = (db: Database, id: number, content: string, ask: string, status: string, startedAt: number, completedAt: number | null) => {
  db.prepare('INSERT INTO sdk_sessions (id, platform_source, content_session_id, memory_session_id, project, user_prompt, status, started_at_epoch, completed_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'claude', content, `m${id}`, 'repo', ask, status, startedAt, completedAt);
  db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(id, 1, ask, startedAt);
};
const viewOf = (db: Database, ledger: any = null) => {
  const state = reduceWorkState([], { currentProject: 'repo' });
  return buildAgentView(state, readAgentRecords(db, { workState: state, ledger, now: NOW }), { ledger, now: NOW });
};

describe('a request whose session has ended', () => {
  it('still names its agent: the session gets its group from its asks alone', () => {
    const db = database();
    // Ended three days ago. Prompts and a summary are captured; there are no
    // observations in the loaded window and no work-state writes.
    addSession(db, 1, 'ended-1', 'Build the release cards', 'completed', NOW - 3 * DAY, NOW - 3 * DAY + 3600000);
    db.prepare('INSERT INTO session_summaries (project, memory_session_id, prompt_number, request, completed, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)')
      .run('repo', 'm1', 1, 'Build the release cards', 'Built the cards', NOW - 3 * DAY + 1800000);
    const view = viewOf(db);
    const [request] = view.humanRequests;
    expect(request.id).toBe(key('ended-1'));
    expect(request.agentIds).toHaveLength(1);
    const agent = view.agents.find((candidate: any) => candidate.id === request.agentIds[0]);
    expect(agent).toBeDefined();
    expect(agent.label).toBe('Claude Code');
    expect(agent.platformSource).toBe('claude');
    expect(agent.sessionId).toBe(1);
    // A completed session row does not date the request's end: the worker
    // also marks a row completed when its observer goes idle mid-conversation.
    expect(request.completedAtEpoch).toBeNull();
  });

  it('an active session with only asks names its agent and stays undated', () => {
    const db = database();
    addSession(db, 1, 'live-1', 'Build the release cards', 'active', NOW - DAY, null);
    const view = viewOf(db);
    const [request] = view.humanRequests;
    expect(request.agentIds).toHaveLength(1);
    expect(view.agents.some((agent: any) => agent.id === request.agentIds[0])).toBe(true);
    expect(request.completedAtEpoch).toBeNull();
  });

  it('a session that already has a group from an observation keeps exactly one agent', () => {
    const db = database();
    addSession(db, 1, 'seen-1', 'Build the release cards', 'completed', NOW - DAY, NOW - DAY + 3600000);
    db.prepare('INSERT INTO observations (project, memory_session_id, prompt_number, title, type, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)')
      .run('repo', 'm1', 1, 'Wrote the card grid', 'discovery', NOW - DAY + 600000);
    const view = viewOf(db);
    expect(view.agents.filter((agent: any) => agent.sessionId === 1)).toHaveLength(1);
    const [request] = view.humanRequests;
    expect(request.agentIds).toHaveLength(1);
    expect(request.completedAtEpoch).toBeNull();
  });

  it('a group whose anchor session was never captured keeps no agent and no completion date', () => {
    const anchorAsk = { text: 'Build the release cards', source: 'user-prompt', sourceId: 11, url: '/api/work-view/evidence/prompt/11', promptNumber: 1, atEpoch: 10 };
    const ledger = { groups: { conversations: { [key('a')]: groupIdFor(key('a')) }, groups: { [groupIdFor(key('a'))]: { title: 'Release cards', anchor: key('a'), anchorAsk } }, ignored: {} }, progress: {} };
    const [request] = buildHumanRequests({ agents: [] }, { sessions: [], prompts: [] }, { ledger }).humanRequests;
    expect(request.agentIds).toEqual([]);
    expect(request.completedAtEpoch).toBeNull();
  });

  it('a conversation the grouping ledger ignored gets no agent group: it backs no card', () => {
    const db = database();
    addSession(db, 1, 'kept-1', 'Build the release cards', 'completed', NOW - 2 * DAY, NOW - 2 * DAY + 3600000);
    addSession(db, 2, 'ignored-1', 'Fix the card spacing', 'completed', NOW - DAY, NOW - DAY + 3600000);
    const ledger = { groups: { conversations: {}, groups: {}, ignored: { [key('ignored-1')]: 'not a goal' } }, progress: {} };
    const view = viewOf(db, ledger);
    expect(view.humanRequests.map((request: any) => request.id)).toEqual([key('kept-1')]);
    expect(view.agents.map((agent: any) => agent.sessionId)).toEqual([1]);
  });
});

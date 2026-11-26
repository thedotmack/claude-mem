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
// the UI's "Agent not recorded" fallback, and nothing dated the request's
// end, so it presented as still in progress.
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
const viewOf = (db: Database) => {
  const state = reduceWorkState([], { currentProject: 'repo' });
  return buildAgentView(state, readAgentRecords(db, { workState: state, now: NOW }), { now: NOW });
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
    // The request stopped running when its only session ended.
    expect(request.completedAtEpoch).toBe(NOW - 3 * DAY + 3600000);
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
    expect(request.completedAtEpoch).toBe(NOW - DAY + 3600000);
  });
});

describe('the completion date of a grouped request', () => {
  const session = (id: number, content: string, ask: string, status: string, at: number, completedAt: number | null) =>
    ({ id, platform_source: 'claude', content_session_id: content, project: 'repo', user_prompt: ask, started_at_epoch: at, status, completed_at_epoch: completedAt });
  const prompt = (id: number, sessionId: number, text: string, at: number) => ({ id, session_db_id: sessionId, prompt_number: 1, prompt_text: text, created_at_epoch: at });
  const ledgerFor = (contents: string[]) => ({
    groups: {
      conversations: Object.fromEntries(contents.map((content) => [key(content), groupIdFor(key(contents[0]))])),
      groups: { [groupIdFor(key(contents[0]))]: { title: 'Cards', anchor: key(contents[0]), projectRoot: 'repo' } },
      ignored: {},
    },
    progress: {},
  });

  it('is the last session end when every conversation has ended, and stays open while one is active', () => {
    const prompts = [prompt(11, 1, 'Build the release cards', 10), prompt(21, 2, 'Fix the card spacing', 20)];
    const ended = [session(1, 'a', 'Build the release cards', 'completed', 10, 5000), session(2, 'b', 'Fix the card spacing', 'completed', 20, 9000)];
    const [done] = buildHumanRequests({ agents: [] }, { sessions: ended, prompts }, { ledger: ledgerFor(['a', 'b']) }).humanRequests;
    expect(done.completedAtEpoch).toBe(9000);
    const oneActive = [ended[0], session(2, 'b', 'Fix the card spacing', 'active', 20, null)];
    const [open] = buildHumanRequests({ agents: [] }, { sessions: oneActive, prompts }, { ledger: ledgerFor(['a', 'b']) }).humanRequests;
    expect(open.completedAtEpoch).toBeNull();
  });

  it('a group whose anchor session was never captured keeps no agent and no completion date', () => {
    const anchorAsk = { text: 'Build the release cards', source: 'user-prompt', sourceId: 11, url: '/api/work-view/evidence/prompt/11', promptNumber: 1, atEpoch: 10 };
    const ledger = { groups: { conversations: { [key('a')]: groupIdFor(key('a')) }, groups: { [groupIdFor(key('a'))]: { title: 'Release cards', anchor: key('a'), anchorAsk } }, ignored: {} }, progress: {} };
    const [request] = buildHumanRequests({ agents: [] }, { sessions: [], prompts: [] }, { ledger }).humanRequests;
    expect(request.agentIds).toEqual([]);
    expect(request.completedAtEpoch).toBeNull();
  });
});

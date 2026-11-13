import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { readRequestWaitingFor, reduceWorkState } from '../../../src/services/work-view/data-source.mjs';
import { toWorkModel } from '../../../src/ui/my-work/src/live/to-work-model.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);

/** A real migrated database with one conversation per name, each opened by one ask an hour ago. */
function databaseWith(...sessions: string[]) {
  const database = new Database(':memory:');
  new SessionStore(database);
  sessions.forEach((name, index) => {
    database.prepare(`INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, 'repo', 'claude', 'Build the gallery', '2026-11-05T11:00:00Z', ?, 'active')`).run(index + 1, name, `memory-${name}`, minutesAgo(60));
    prompt(database, name, 60);
  });
  return database;
}
function prompt(database: Database, session: string, minutes: number) {
  const { id } = database.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get(session) as { id: number };
  const { count } = database.prepare('SELECT COUNT(*) AS count FROM user_prompts WHERE session_db_id = ?').get(id) as { count: number };
  database.prepare(`INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, 'Build the gallery', '2026-11-05T11:00:00Z', ?)`).run(id, session, count + 1, minutesAgo(minutes));
}
function summary(database: Database, session: string, minutes: number, waitingFor: string | null) {
  database.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, waiting_for, created_at, created_at_epoch)
    VALUES (?, 'repo', 'Build the gallery', ?, '2026-11-05T11:30:00Z', ?)`).run(`memory-${session}`, waitingFor, minutesAgo(minutes));
}

describe('what a request card says its latest turn waits for', () => {
  it('is the value on the newest summary of the request, across its conversations', () => {
    const database = databaseWith('one', 'two');
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBeNull();
    summary(database, 'one', 30, 'answer');
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBe('answer');
    summary(database, 'two', 20, 'review');
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBe('review');
    expect(readRequestWaitingFor(database, [key('one')])).toBe('answer');
    summary(database, 'two', 10, 'nothing');
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBe('nothing');
  });

  it('is null once the owner has prompted since, and when the newest summary did not say', () => {
    const database = databaseWith('one', 'two');
    summary(database, 'one', 30, 'approval');
    prompt(database, 'two', 20);
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBeNull();
    summary(database, 'two', 10, 'review');
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBe('review');
    summary(database, 'two', 5, null);
    expect(readRequestWaitingFor(database, [key('one'), key('two')])).toBeNull();
  });

  it('gives nothing for a stored word outside the list, a key that is no conversation, or a database without the column', () => {
    const database = databaseWith('one');
    summary(database, 'one', 30, 'merge');
    expect(readRequestWaitingFor(database, [key('one')])).toBeNull();
    expect(readRequestWaitingFor(database, ['work-state:7', key('absent')])).toBeNull();
    database.exec('ALTER TABLE session_summaries DROP COLUMN waiting_for');
    expect(readRequestWaitingFor(database, [key('one')])).toBeNull();
  });

  it('reads through the keys a projected request carries, and the mapped card keeps the value', () => {
    const database = databaseWith('one');
    summary(database, 'one', 30, 'review');
    const state = reduceWorkState([], { currentProject: 'repo', currentProjectScope: ['repo'] });
    const view = buildAgentView(state, readAgentRecords(database, { workState: state, now: NOW }), { now: NOW });
    const [request] = view.humanRequests;
    expect(request.conversationKeys).toEqual([key('one')]);
    const waitingFor = readRequestWaitingFor(database, request.conversationKeys);
    const model = toWorkModel({ ...view, humanRequests: [{ ...request, waitingFor }], source: { kind: 'test', connected: true, error: null, lastCheckedAt: null }, revision: '1', generatedAt: new Date(NOW).toISOString() } as any, NOW);
    expect(model.requestReadErrors).toEqual([]);
    expect(model.requests[0].waitingFor).toBe('review');
  });
});

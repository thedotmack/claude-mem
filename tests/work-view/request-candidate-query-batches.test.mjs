import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readCandidates } from '../../src/services/work-view/request-groups.mjs';

const key = (id) => JSON.stringify(['conversation', 'claude', 'session-' + id]);

function fixture(count) {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER, cwd TEXT);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);`);
  const insert = database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
  database.transaction(() => {
    for (let id = 1; id <= count; id++) {
      insert.run(id, 'claude', 'session-' + id, 'memory-' + id, 'repo', 'Fix the search results', 1000 + id);
    }
  })();
  database.prepare('INSERT INTO user_prompts VALUES (1, ?, 1, ?, 100000)').run(count, 'Fix the final search result');
  database.prepare('INSERT INTO tool_uses VALUES (1, ?, ?, ?, 120000)').run(count, 'mcp__work_state_write', JSON.stringify({ list: 'search', fields: { request_id: 'request-final' } }));
  database.prepare('INSERT INTO observations VALUES (1, ?, ?, ?, ?, 110000)').run('memory-' + count, 'change', 'Search fixed', '');
  database.prepare('INSERT INTO observations VALUES (2, ?, ?, ?, ?, 115000)').run('memory-' + count, 'verification', 'Search verified', '');
  return database;
}

describe('request candidate queries across SQLite parameter limits', () => {
  it('reads every candidate and its related activity from a large history', () => {
    const database = fixture(35000);
    try {
      const candidates = readCandidates(database, { sinceEpoch: 0 });
      expect(candidates).toHaveLength(35000);
      expect(candidates[0].conversationKey).toBe(key(1));
      const last = candidates.at(-1);
      expect(last.conversationKey).toBe(key(35000));
      expect(last.asks.map((ask) => ask.text)).toEqual(['Fix the final search result']);
      expect(last.askCount).toBe(1);
      expect(last.workLists).toEqual(['search']);
      expect(last.requestIds).toEqual(['request-final']);
      expect(last.observationCount).toBe(2);
      expect(last.lastActivityEpoch).toBe(120000);
    } finally {
      database.close();
    }
  }, 30000);

  it('resolves a large explicit conversation selection', () => {
    const database = fixture(17000);
    try {
      const candidates = readCandidates(database, { conversationKeys: Array.from({ length: 17000 }, (_, index) => key(index + 1)) });
      expect(candidates).toHaveLength(17000);
      expect(candidates.at(-1).conversationKey).toBe(key(17000));
      expect(candidates.at(-1).requestIds).toEqual(['request-final']);
    } finally {
      database.close();
    }
  }, 30000);

  it('does not duplicate prompts when selected keys repeat across batches', () => {
    const database = fixture(1);
    try {
      const candidates = readCandidates(database, { conversationKeys: Array.from({ length: 501 }, () => key(1)) });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].askCount).toBe(1);
      expect(candidates[0].observationCount).toBe(2);
      expect(candidates[0].requestIds).toEqual(['request-final']);
      expect(readCandidates(database, { conversationKeys: [] })).toEqual([]);
    } finally {
      database.close();
    }
  });
});

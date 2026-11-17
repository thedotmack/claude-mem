import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupingInput, groupIdFor, readCandidates, runCli } from '../../src/services/work-view/request-groups.mjs';
import { scratchDir } from '../helpers/scratch-dir.js';

const key = (id: number) => JSON.stringify(['conversation', 'claude', `session-${id}`]);
const groupId = groupIdFor(key(1));
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture({ count = 15, tied = false, members = 1 } = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER, cwd TEXT);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, created_at_epoch INTEGER);`);
  const conversations: Record<string, string> = {};
  const addSession = db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
  const addPrompt = db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)');
  for (let id = 1; id <= members + 1; id++) {
    addSession.run(id, 'claude', `session-${id}`, `memory-${id}`, 'repo', `Build feature ${id}`, id);
    if (id <= members) conversations[key(id)] = groupId;
    for (let number = 1; number <= (id <= members ? count : 1); number++) {
      addPrompt.run(id, number, `Fix feature ${id} detail ${number}`, tied ? 1000 : number * 100 + id);
    }
  }
  const ledger = { groups: { conversations, groups: { [groupId]: { title: 'Feature work', anchor: key(1), projectRoot: 'repo', anchorAsk: { text: 'Build feature 1' } } }, ignored: {} }, progress: {}, agentWrittenPromptIds: new Set<number>() };
  return { db, ledger };
}

it('grouping receives the latest asks after a conversation exceeds the listing window', () => {
  const { db, ledger } = fixture();
  const input = groupingInput(ledger, db, { sinceEpoch: 0 });
  expect(input.openRequests[0].recentAsks).toEqual([15, 14, 13].map(n => `Fix feature 1 detail ${n}`));
  expect(input.openRequests[0].anchorAsk).toBe('Build feature 1');
  expect(input.conversations.map(c => c.conversationKey)).toEqual([key(2)]);
});

it('prompt IDs break equal timestamp ties newest first', () => {
  const { db, ledger } = fixture({ tied: true });
  expect(groupingInput(ledger, db, { sinceEpoch: 0 }).openRequests[0].recentAsks)
    .toEqual([15, 14, 13].map(n => `Fix feature 1 detail ${n}`));
});

it('the newest asks are selected across all conversations in the request', () => {
  const { db, ledger } = fixture({ members: 2 });
  expect(groupingInput(ledger, db, { sinceEpoch: 0 }).openRequests[0].recentAsks)
    .toEqual(['Fix feature 2 detail 15', 'Fix feature 1 detail 15', 'Fix feature 2 detail 14']);
});

it('excluded prompts and non-requests do not displace recent human requests', () => {
  const { db, ledger } = fixture();
  ledger.agentWrittenPromptIds.add(15);
  db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE id = 14').run('thanks');
  expect(groupingInput(ledger, db, { sinceEpoch: 0 }).openRequests[0].recentAsks)
    .toEqual([13, 12, 11].map(n => `Fix feature 1 detail ${n}`));
});

it('the CLI emits the same recent evidence from the saved ledger', () => {
  const { db, ledger } = fixture();
  const dir = scratchDir('grouping-recent-asks');
  try {
    writeFileSync(join(dir, 'request-groups.json'), JSON.stringify(ledger.groups));
    let printed: any;
    runCli(['grouping-input'], { dir, database: db, now: 2000, print: value => { printed = value; } });
    expect(printed.openRequests[0].recentAsks).toEqual([15, 14, 13].map(n => `Fix feature 1 detail ${n}`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('ordinary candidate listings keep their opening window and full reads keep every ask', () => {
  const { db } = fixture();
  const options = { conversationKeys: [key(1)] };
  const [listed] = readCandidates(db, options);
  const [full] = readCandidates(db, { ...options, fullAsks: true });
  expect(listed.asks.map((ask: any) => ask.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Fix feature 1 detail ${i + 1}`));
  expect(full.asks).toHaveLength(15);
  expect(full.asks.at(-1).text).toBe('Fix feature 1 detail 15');
});

it('a short conversation still supplies its newest asks', () => {
  const { db, ledger } = fixture({ count: 2 });
  expect(groupingInput(ledger, db, { sinceEpoch: 0 }).openRequests[0].recentAsks)
    .toEqual(['Fix feature 1 detail 2', 'Fix feature 1 detail 1']);
});

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGroupDecisions, groupIdFor, linkBackwards, readCandidates, readLedger, runCli, validateProgress } from '../../src/services/work-view/request-groups.mjs';
import { buildHumanRequests } from '../../src/services/work-view/request-projection.mjs';

const ledgerDir = () => mkdtempSync(join(tmpdir(), 'request-groups-test-'));
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const DAY = 86400000, NOW = 100 * DAY;

function fixtureDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, created_at_epoch INTEGER);`);
  const session = db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
  const prompt = db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)');
  const write = db.prepare('INSERT INTO tool_uses (session_db_id, tool_name, tool_input, created_at_epoch) VALUES (?, ?, ?, ?)');
  // Two conversations (one after /clear) record into the same work list; a third is unrelated.
  session.run(1, 'claude', 'a', 'm1', 'repo/tree', 'Build the release cards', NOW - 3 * DAY);
  session.run(2, 'claude', 'b', 'm2', 'repo/tree', 'Fix the card spacing', NOW - 2 * DAY);
  session.run(3, 'claude', 'c', 'm3', 'repo/other', 'Write the pricing page', NOW - DAY);
  prompt.run(1, 1, 'Build the release cards', NOW - 3 * DAY);
  prompt.run(2, 1, 'Fix the card spacing', NOW - 2 * DAY);
  prompt.run(3, 1, 'Write the pricing page', NOW - DAY);
  write.run(1, 'mcp__work_state_write', JSON.stringify({ list: 'release-cards', fields: { task: 'cards' } }), NOW - 3 * DAY);
  write.run(2, 'mcp__work_state_write', JSON.stringify({ list: 'release-cards', fields: { task: 'spacing' } }), NOW - 2 * DAY);
  db.prepare('INSERT INTO observations (memory_session_id, created_at_epoch) VALUES (?, ?)').run('m2', NOW - DAY);
  return db;
}


describe('overall requests and progress reviews', () => {
  it('work backwards: a shared work list links conversations into one overall request', () => {
  const candidates = readCandidates(fixtureDatabase(), { sinceEpoch: NOW - 14 * DAY });
  expect(candidates.map((candidate) => candidate.conversationKey)).toEqual([key('a'), key('b'), key('c')]);
  expect(candidates[1].lastActivityEpoch).toBe(NOW - DAY);
  const { proposedGroups } = linkBackwards(candidates);
  const linked = proposedGroups.find((group) => group.conversations.length === 2);
  expect(linked.conversations).toEqual([key('a'), key('b')]);
  expect(linked.links[0].evidence).toBe('work list "release-cards" in repo/tree');
  expect(proposedGroups.length).toBe(2);
});

  it('group decisions need evidence and keep a stable anchor id', () => {
  expect(() => applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')] }] })).toThrow(/without a recorded link/);
  expect(() => applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: [{ kind: 'agent-judgment', evidence: '' }] }] })).toThrow(/without evidence/);
  const first = applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a')] }, { title: 'Spacing', conversations: [key('b')] }] }, NOW);
  const merged = applyGroupDecisions(first, { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'agent-judgment', conversations: [key('a'), key('b')], evidence: '"this is excellent work, can you now…" continues the card work' }] }] }, NOW);
  expect(merged.conversations[key('b')]).toBe(groupIdFor(key('a')));
  expect(Object.keys(merged.groups)).toEqual([groupIdFor(key('a'))]);
  const ignored = applyGroupDecisions(merged, { groups: [], ignored: [{ conversation: key('c'), reason: 'Automated workspace naming prompt' }] }, NOW);
  expect(ignored.ignored[key('c')]).toBe('Automated workspace naming prompt');
});

  it('progress reviews are validated: shipped needs a date and 100%', () => {
  const groups = { g_000000000001: { title: 'Cards' } };
  const base = { groupId: 'g_000000000001', state: 'shipped', percent: 100, startedAt: '2026-10-01T00:00:00Z', shippedAt: '2026-10-03T00:00:00Z', summary: 'Cards merged and released.', reviewBasis: { checkedThrough: '2026-10-04T00:00:00Z', conversations: [key('a')] } };
  expect(validateProgress(base, groups).state).toBe('shipped');
  expect(() => validateProgress({ ...base, percent: 90 }, groups)).toThrow(/percent 100/);
  expect(() => validateProgress({ ...base, state: 'in-progress', percent: 50 }, groups)).toThrow(/Only a shipped/);
  expect(() => validateProgress({ ...base, groupId: 'g_ffffffffffff' }, groups)).toThrow(/Unknown group/);
  expect(() => validateProgress({ ...base, preferences: [{ kind: 'vibe', preference: 'x', quote: 'y' }] }, groups)).toThrow(/kind/);
  expect(() => validateProgress({ ...base, reviewBasis: undefined }, groups)).toThrow(/reviewBasis/);
});

  it('a review records how released work landed, with evidence and the why of each change', () => {
  const groups = { g_000000000001: { title: 'Cards' } };
  const base = { groupId: 'g_000000000001', state: 'shipped', percent: 100, shippedAt: '2026-10-03T00:00:00Z', summary: 'Cards merged and released.', reviewBasis: { checkedThrough: '2026-10-04T00:00:00Z', conversations: [key('a')] } };
  const outcome = {
    landed: { text: 'Released in v14.0.0 on Oct 3.', at: '2026-10-03T00:00:00Z', evidence: ['PR #4845'] },
    usage: { level: 'in-use', text: 'Owner opened My Work daily since.', evidence: ['obs 101'] },
    value: { level: 'high', text: 'Replaced the manual standup.', evidence: ['Oct 5 ask: "this is excellent work"'] },
    regressions: [{ text: 'Cards lost summaries after a refresh.', at: '2026-10-04T00:00:00Z', fixedBy: 'PR #4850', evidence: ['obs 120'] }],
    changes: [{ what: 'Restored the approved cards', why: 'Owner: "restore the approved My Work cards"', evidence: ['ce3636c05'] }],
  };
  const recorded = validateProgress({ ...base, outcome }, groups).outcome;
  expect(recorded.usage.level).toBe('in-use');
  expect(recorded.regressions[0].fixedBy).toBe('PR #4850');
  expect(recorded.changes[0].at).toBeNull();
  expect(validateProgress(base, groups).outcome).toBeNull();
  expect(() => validateProgress({ ...base, outcome: { usage: { level: 'popular', text: 'x' } } }, groups)).toThrow(/usage.level/);
  expect(() => validateProgress({ ...base, outcome: { changes: [{ what: 'x' }] } }, groups)).toThrow(/why/);
});

  it('CLI round trip: apply groups, see them due, record a review, then nothing is due', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const { proposedGroups } = run(['candidates', '--days', '14']);
    const decisions = join(dir, 'decisions.json');
    writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', ...proposedGroups[0] }, { title: 'Pricing page', conversations: [key('c')] }] }));
    expect(run(['apply', decisions])).toEqual({ groups: 2, conversations: 3 });
    const pending = run(['pending', '--days', '14']);
    expect(pending.due).toBe(2);
    expect(pending.ungroupedConversations).toBe(0);
    const groupId = groupIdFor(key('a'));
    const review = join(dir, 'review.json');
    const { reviewBasis } = run(['show', groupId]);
    writeFileSync(review, JSON.stringify({ groupId, state: 'in-progress', percent: 70, startedAt: new Date(NOW - 3 * DAY).toISOString(), summary: 'Cards built; spacing fix in review.', preferences: [{ kind: 'directive', preference: 'Execute clear asks without asking.', quote: 'just do it', at: null }], reviewBasis }));
    expect(run(['record-progress', review]).percent).toBe(70);
    expect(readLedger(dir).progress[groupId].title).toBe('Release cards');
    expect(run(['pending', '--days', '14']).groups.map((group) => group.title)).toEqual(['Pricing page']);
    expect(run(['show', groupId]).conversations.length).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('projection merges conversations in a group and starts at the earliest ask', () => {
  const groupId = groupIdFor(key('a'));
  const ledger = { groups: { conversations: { [key('a')]: groupId, [key('b')]: groupId }, groups: { [groupId]: { title: 'Release cards' } } }, progress: { [groupId]: { groupId, state: 'in-progress', percent: 60 } } };
  const sessions = [
    { id: 2, platform_source: 'claude', content_session_id: 'b', user_prompt: 'Fix the card spacing', started_at_epoch: 20 },
    { id: 1, platform_source: 'claude', content_session_id: 'a', user_prompt: 'Build the release cards', started_at_epoch: 10 },
  ];
  const prompts = [
    { id: 21, session_db_id: 2, prompt_number: 1, prompt_text: 'Fix the card spacing', created_at_epoch: 20 },
    { id: 11, session_db_id: 1, prompt_number: 1, prompt_text: 'Build the release cards', created_at_epoch: 10 },
  ];
  const item = (id: number) => ({ id, title: `work ${id}`, kind: 'work-state', listId: 'cards', listName: 'release-cards', project: 'repo/tree', lastUpdateEpoch: id });
  const view = { agents: [{ id: 'later', label: 'Claude Code', sessionId: 2, work: [item(2)] }, { id: 'earlier', label: 'Claude Code', sessionId: 1, work: [item(1)] }] };
  const { humanRequests } = buildHumanRequests(view, { sessions, prompts }, { ledger });
  expect(humanRequests.length).toBe(1);
  expect(humanRequests[0].id).toBe(JSON.stringify(['overall-request', groupId]));
  expect(humanRequests[0].original.sourceId).toBe(11);
  expect(humanRequests[0].progress.percent).toBe(60);
  expect(humanRequests[0].title).toBe('Release cards');
  expect(new Set(humanRequests[0].conversationKeys)).toEqual(new Set([key('a'), key('b')]));
  const ungrouped = buildHumanRequests(view, { sessions, prompts });
  expect(ungrouped.humanRequests.length).toBe(2);
});

  it('a work list name links conversations only within one project', () => {
  const candidate = (id: string, project: string) => ({ conversationKey: key(id), project, workLists: ['release'], requestIds: [] });
  const { proposedGroups } = linkBackwards([candidate('a', 'repo-one'), candidate('b', 'repo-two'), candidate('c', 'repo-one')]);
  expect(proposedGroups.map((group) => group.conversations)).toEqual([[key('a'), key('c')], [key('b')]]);
});

  it('every joined conversation needs a link back to the anchor', () => {
  const link = (conversations: string[]) => ({ kind: 'agent-judgment', conversations, evidence: 'continues the card work' });
  expect(() => applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b'), key('c')], links: [link([key('a'), key('b')])] }] })).toThrow(/without evidence linking/);
  expect(() => applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: [link([key('a'), key('z')])] }] })).toThrow(/group's own conversations/);
  expect(() => applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b'), key('c')], links: [link([key('a'), key('b')]), link([key('b'), key('c')])] }] })).not.toThrow();
});

  it('a review goes stale when membership changes or unseen activity exists', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const decisions = join(dir, 'decisions.json');
    writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a')] }, { title: 'Spacing', conversations: [key('b')] }, { title: 'Pricing page', conversations: [key('c')] }] }));
    run(['apply', decisions]);
    const groupId = groupIdFor(key('a'));
    // The reviewer read `show` before the latest activity (NOW - DAY) and saves later.
    const { reviewBasis, conversations } = run(['show', groupId], NOW - 2 * DAY);
    expect(conversations[0].asks[0].text).toBe('Build the release cards');
    const review = join(dir, 'review.json');
    writeFileSync(review, JSON.stringify({ groupId, state: 'in-progress', percent: 50, summary: 'Cards started.', reviewBasis }));
    run(['record-progress', review]);
    const due = () => run(['pending', '--days', '14']).groups.map((group: { groupId: string }) => group.groupId);
    // Nothing happened in that conversation after show.
    expect(due()).not.toContain(groupId);
    // Merge spacing in: old activity, new membership, so it is due again.
    writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }] }));
    run(['apply', decisions]);
    expect(due()).toContain(groupId);
    // Reviewed with the new membership, but the observation at NOW - DAY came after the reviewer's show.
    writeFileSync(review, JSON.stringify({ groupId, state: 'in-progress', percent: 60, summary: 'Cards and spacing.', reviewBasis: run(['show', groupId], NOW - 1.5 * DAY).reviewBasis }));
    run(['record-progress', review]);
    // Activity after checkedThrough stays due even though the save came later.
    expect(due()).toContain(groupId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('recent observations and work-state writes bring older conversations into the window', () => {
  const database = fixtureDatabase();
  database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(4, 'claude', 'd', 'm4', 'repo/tree', 'Build the old dashboard', NOW - 40 * DAY);
  database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(4, 1, 'Build the old dashboard', NOW - 40 * DAY);
  const inWindow = () => readCandidates(database, { sinceEpoch: NOW - 14 * DAY }).some((candidate) => candidate.conversationKey === key('d'));
  expect(inWindow()).toBe(false);
  database.prepare('INSERT INTO observations (memory_session_id, created_at_epoch) VALUES (?, ?)').run('m4', NOW - DAY);
  expect(inWindow()).toBe(true);
});

  it('show returns every ask in full', () => {
  const database = fixtureDatabase();
  const prompt = database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)');
  for (let number = 2; number <= 13; number += 1) prompt.run(1, number, `Fix card detail ${number} ${'x'.repeat(400)}`, NOW - 3 * DAY + number);
  const [listed] = readCandidates(database, { conversationKeys: [key('a')] });
  const [full] = readCandidates(database, { conversationKeys: [key('a')], fullAsks: true });
  expect(listed.asks.length).toBe(10);
  expect(full.asks.length).toBe(13);
  expect(full.asks.at(-1).text.length).toBeGreaterThan(400);
});

  it('projection hides ignored conversations and keeps the stored anchor ask as the start', () => {
  const groupId = groupIdFor(key('a'));
  const anchorAsk = { text: 'Build the release cards', source: 'user-prompt', sourceId: 11, url: '/api/work-view/evidence/prompt/11', promptNumber: 1, atEpoch: 10 };
  const ledger = { groups: { conversations: { [key('a')]: groupId, [key('b')]: groupId }, groups: { [groupId]: { title: 'Release cards', anchorAsk } }, ignored: { [key('c')]: 'Automated naming prompt' } }, progress: {} };
  // Only the later conversation and an ignored one are loaded; the anchor aged out.
  const sessions = [
    { id: 2, platform_source: 'claude', content_session_id: 'b', user_prompt: 'Fix the card spacing', started_at_epoch: 20 },
    { id: 3, platform_source: 'claude', content_session_id: 'c', user_prompt: 'Generate a short name for this workspace', started_at_epoch: 30 },
  ];
  const prompts = [{ id: 21, session_db_id: 2, prompt_number: 1, prompt_text: 'Fix the card spacing', created_at_epoch: 20 }];
  const item = (id: number) => ({ id, title: `work ${id}`, kind: 'work-state', listId: 'cards', project: 'repo/tree', lastUpdateEpoch: id });
  const view = { agents: [{ id: 'later', label: 'Claude Code', sessionId: 2, work: [item(2)] }, { id: 'bot', label: 'Codex', sessionId: 3, work: [item(3)] }] };
  const { humanRequests, unlinkedWork } = buildHumanRequests(view, { sessions, prompts }, { ledger });
  expect(humanRequests.length).toBe(1);
  expect(humanRequests[0].original.sourceId).toBe(11);
  expect(humanRequests[0].startedAtEpoch).toBe(10);
  expect(unlinkedWork.find((work: { agentId: string }) => work.agentId === 'bot').reason).toBe('ignored-by-request-grouping');
});

});

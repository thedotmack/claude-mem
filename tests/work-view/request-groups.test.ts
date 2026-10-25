import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReading, applyGroupDecisions, groupIdFor, ledgerSignature, linkBackwards, MAX_READINGS, readCandidates, readGoals, readLedger, refreshNeeds, runCli, validateAlignment, validateProgress } from '../../src/services/work-view/request-groups.mjs';
import { WorkStateSource } from '../../src/services/work-view/data-source.mjs';
import { buildHumanRequests } from '../../src/services/work-view/request-projection.mjs';

const ledgerDir = () => mkdtempSync(join(tmpdir(), 'request-groups-test-'));
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const DAY = 86400000, NOW = 100 * DAY;

function fixtureDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
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
  const corrected = applyGroupDecisions(ignored, { groups: [{ title: 'Pricing page', conversations: [key('c')] }] }, NOW);
  expect(corrected.conversations[key('c')]).toBe(groupIdFor(key('c')));
  expect(corrected.ignored[key('c')]).toBeUndefined();
});

  it('a commit or push after a review counts as new activity, with no new prompt or observation', () => {
  const db = fixtureDatabase();
  db.prepare('INSERT INTO tool_uses (session_db_id, tool_name, tool_input, created_at_epoch) VALUES (?, ?, ?, ?)').run(3, 'Bash', JSON.stringify({ command: 'git push' }), NOW - 1000);
  const byKey = new Map(readCandidates(db, { sinceEpoch: NOW - 14 * DAY }).map((candidate) => [candidate.conversationKey, candidate]));
  expect(byKey.get(key('c')).lastActivityEpoch).toBe(NOW - 1000);
  // Inside a window that only the push falls in, the conversation is still found.
  const recent = readCandidates(db, { sinceEpoch: NOW - 2000 });
  expect(recent.map((candidate) => candidate.conversationKey)).toEqual([key('c')]);
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

  it('goals fold the current owner-goals list and drop closed items and history', () => {
  const database = fixtureDatabase();
  saveGoals(database, '2026-10-01T10:00:00Z');
  const goals = readGoals(database);
  expect(goals.summary).toBe('Ship the cards.');
  expect(goals.goals.map((goal) => [goal.goal, goal.kind, goal.rank])).toEqual([['Priority: Ship cards', 'priority', 1]]);
  expect(goals.goals[0].evidence).toEqual([{ at: '2026-10-01 10:00', quote: 'ship the cards | today' }]);
});

  it('alignment links only known groups to exact current goals, with evidence', () => {
  const context = { groups: { g_000000000001: {}, g_000000000002: {} }, goals: [{ goal: 'Priority: Ship cards' }] };
  const valid = validateAlignment({ links: [{ groupId: 'g_000000000001', goal: 'Priority: Ship cards', evidence: 'The card work is the release the owner asked for.' }], unaligned: ['g_000000000002'] }, context);
  expect(valid.links.g_000000000001[0].goal).toBe('Priority: Ship cards');
  expect(valid.unaligned).toEqual(['g_000000000002']);
  expect(() => validateAlignment({ links: [{ groupId: 'g_000000000001', goal: 'Ship cards', evidence: 'x' }] }, context)).toThrow(/exact "goal"/);
  expect(() => validateAlignment({ links: [{ groupId: 'g_ffffffffffff', goal: 'Priority: Ship cards', evidence: 'x' }] }, context)).toThrow(/unknown group/);
  expect(() => validateAlignment({ links: [{ groupId: 'g_000000000001', goal: 'Priority: Ship cards', evidence: '' }] }, context)).toThrow(/evidence/);
  expect(() => validateAlignment({ links: [{ groupId: 'g_000000000001', goal: 'Priority: Ship cards', evidence: 'x' }], unaligned: ['g_000000000001'] }, context)).toThrow(/both linked and unaligned/);
  expect(() => validateAlignment({ unaligned: [] }, context)).toThrow(/links array/);
});

  it('CLI alignment round trip: align-input lists goals and groups, record-alignment writes alignment.json', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    saveGoals(database, '2026-10-01T10:00:00Z');
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const decisions = join(dir, 'decisions.json');
    writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a')] }, { title: 'Pricing page', conversations: [key('c')] }] }));
    run(['apply', decisions]);
    const before = ledgerSignature(dir);
    const input = run(['align-input']);
    expect(input.goals.goals.map((goal: { goal: string }) => goal.goal)).toEqual(['Priority: Ship cards']);
    expect(input.groups.map((group: { title: string; firstAsk: string }) => [group.title, group.firstAsk])).toEqual([['Release cards', 'Build the release cards'], ['Pricing page', 'Write the pricing page']]);
    expect(input.previous).toBeNull();
    const alignment = join(dir, 'alignment-input.json');
    writeFileSync(alignment, JSON.stringify({ links: [{ groupId: groupIdFor(key('a')), goal: 'Priority: Ship cards', evidence: 'Release cards are the cards to ship.' }], unaligned: [groupIdFor(key('c'))] }));
    expect(run(['record-alignment', alignment])).toEqual({ aligned: 1, unaligned: 1 });
    const stored = readLedger(dir).alignment;
    expect(stored.links[groupIdFor(key('a'))][0].goal).toBe('Priority: Ship cards');
    expect(stored.unaligned).toEqual([groupIdFor(key('c'))]);
    expect(stored.goals).toEqual(['Priority: Ship cards']);
    expect(ledgerSignature(dir)).not.toBe(before);
    expect(run(['align-input']).previous.alignedAt).toBe(new Date(NOW).toISOString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('align-input lists only groups still to align; record-alignment keeps the other groups\' links', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    saveGoals(database, '2026-10-01T10:00:00Z');
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    run(['apply', write('d1.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }] })]);
    run(['record-alignment', write('a1.json', { links: [{ groupId: groupIdFor(key('a')), goal: 'Priority: Ship cards', evidence: 'The cards.' }] })]);
    run(['apply', write('d2.json', { groups: [{ title: 'Pricing page', conversations: [key('c')] }] })]);
    // Only the new group is listed; the aligned one is not sent again.
    expect(run(['align-input']).groups.map((group: { groupId: string }) => group.groupId)).toEqual([groupIdFor(key('c'))]);
    expect(refreshNeeds({ dir, database, now: NOW }).unaligned).toBe(1);
    expect(() => run(['record-alignment', write('a2.json', { links: [] })])).toThrow(/missing g_/);
    expect(run(['record-alignment', write('a3.json', { links: [], unaligned: [groupIdFor(key('c'))] })])).toEqual({ aligned: 0, unaligned: 1 });
    const stored = readLedger(dir).alignment;
    expect(stored.links[groupIdFor(key('a'))][0].evidence).toBe('The cards.');
    expect(stored.unaligned).toEqual([groupIdFor(key('c'))]);
    expect(run(['align-input']).groups).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('a request that changed since it was aligned is aligned again; an unchanged one is not', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    saveGoals(database, '2026-10-01T10:00:00Z');
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const group = groupIdFor(key('a'));
    run(['apply', write('d1.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    run(['record-alignment', write('a1.json', { links: [{ groupId: group, goal: 'Priority: Ship cards', evidence: 'The cards.' }], unaligned: [groupIdFor(key('c'))] })]);
    expect(run(['align-input']).groups).toEqual([]);
    // A new review says what the request is now; the decision was made on the old one.
    run(['record-progress', write('r.json', { groupId: group, state: 'in-progress', percent: 40, summary: 'Now the pricing page too.', reviewBasis: run(['show', group]).reviewBasis })]);
    expect(run(['align-input']).groups.map((entry: { groupId: string }) => entry.groupId)).toEqual([group]);
    expect(refreshNeeds({ dir, database, now: NOW }).unaligned).toBe(1);
    run(['record-alignment', write('a2.json', { links: [{ groupId: group, goal: 'Priority: Ship cards', evidence: 'Still the cards.' }] })]);
    expect(run(['align-input']).groups).toEqual([]);
    // A merged-in conversation changes the request too.
    run(['apply', write('d2.json', { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }] })]);
    expect(run(['align-input']).groups.map((entry: { groupId: string }) => entry.groupId)).toEqual([group]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('a re-review that adds an owner preference, a ship date fix or a regression reaches the story, at the same state and percent', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const group = groupIdFor(key('a'));
    run(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }] })]);
    const review = (now: number, extra: object) => run(['record-progress', write('r.json', { groupId: group, state: 'in-progress', percent: 40, summary: 'Under way.', reviewBasis: run(['show', group], now).reviewBasis, ...extra })], now);
    review(NOW, {});
    run(['record-story', write('s.json', { narrative: 'One request under way.' })], NOW + 1000);
    // Reworded prose alone is not new story content.
    review(NOW + 2000, { summary: 'Still under way.' });
    expect(run(['story-input']).reviews).toEqual([]);
    review(NOW + 3000, { preferences: [{ kind: 'directive', preference: 'Fail loudly at limits', quote: 'fail loudly', at: null }] });
    expect(run(['story-input']).reviews.map((entry: { groupId: string }) => entry.groupId)).toEqual([group]);
    run(['record-story', write('s2.json', { narrative: 'One request under way.' })], NOW + 4000);
    review(NOW + 5000, { preferences: [{ kind: 'directive', preference: 'Fail loudly at limits', quote: 'fail loudly', at: null }], outcome: { regressions: [{ text: 'Cards lost their dates', at: null }] } });
    expect(run(['story-input']).reviews.map((entry: { groupId: string }) => entry.groupId)).toEqual([group]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('show: a re-review with the same conversations amends the previous review from the new asks only', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const group = groupIdFor(key('a'));
    run(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }] })]);
    const first = run(['show', group]);
    expect(first).toMatchObject({ mode: 'full', amendSince: null });
    run(['record-progress', write('r.json', { groupId: group, state: 'in-progress', percent: 40, summary: 'Under way.', reviewBasis: first.reviewBasis })]);
    database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(1, 2, 'Now add the release date to each card', NOW + DAY);
    database.prepare('INSERT INTO observations (memory_session_id, type, title, subtitle, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run('m1', 'feature', 'Release dates on cards', 'Each card shows its date', NOW + DAY);
    database.prepare('INSERT INTO observations (memory_session_id, type, title, subtitle, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run('m1', 'feature', 'Cards built', 'Before the review', NOW - DAY);
    expect(run(['show', group], NOW + 2 * DAY).conversations[0].observations).toMatchObject([{ title: 'Release dates on cards', type: 'feature', at: new Date(NOW + DAY).toISOString() }]);
    const amend = run(['show', group], NOW + 2 * DAY);
    expect(amend).toMatchObject({ mode: 'amend', amendSince: new Date(NOW).toISOString(), previousReview: { percent: 40 } });
    expect(amend.conversations[0].asks.map((ask: { text: string }) => ask.text)).toEqual(['Now add the release date to each card']);
    // A merged-in conversation changes what was reviewed: a full review again.
    run(['apply', write('d2.json', { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }] })]);
    const full = run(['show', group], NOW + 2 * DAY);
    expect(full.mode).toBe('full');
    expect(full.conversations.find((conversation: { conversationKey: string }) => conversation.conversationKey === key('a')).asks).toHaveLength(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('story-input lists every review without a story, then only reviews whose facts changed', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    run(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    const review = (session: string, percent: number, now: number) => run(['record-progress', write('r.json', { groupId: groupIdFor(key(session)), state: 'in-progress', percent, summary: 'Under way.', reviewBasis: run(['show', groupIdFor(key(session))], now).reviewBasis })], now);
    review('a', 40, NOW); review('c', 40, NOW);
    expect(run(['story-input'])).toMatchObject({ update: false, reviews: [{ percent: 40 }, { percent: 40 }] });
    run(['record-story', write('s.json', { narrative: 'Two requests under way.' })], NOW + 1000);
    // Re-reviewed with the same state and percent: the story still holds.
    review('a', 40, NOW + 2000);
    expect(run(['story-input'])).toMatchObject({ update: true, reviews: [] });
    review('c', 60, NOW + 3000);
    const input = run(['story-input']);
    expect(input.reviews.map((entry: { groupId: string }) => entry.groupId)).toEqual([groupIdFor(key('c'))]);
    expect(input.previousStory.narrative).toBe('Two requests under way.');
    // The agent gets its budget up front, and an over-long story is refused with its length.
    expect(input).toMatchObject({ narrativeLimit: 12000, previousNarrativeChars: 'Two requests under way.'.length, roomChars: 12000 - 'Two requests under way.'.length });
    expect(() => run(['record-story', write('s.json', { narrative: 'x'.repeat(12001) })])).toThrow('narrative is 12001 characters; it must be 1–12000. Cut at least 1 characters.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('a refresh is needed for due reviews, stale goals or unaligned groups, and not otherwise', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    expect(refreshNeeds({ dir, database, now: NOW })).toEqual({ due: 0, ungrouped: 3, goalsStale: true, unaligned: 0, needed: true });
    saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
    const decisions = join(dir, 'decisions.json');
    writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }, { title: 'Pricing page', conversations: [key('c')] }] }));
    run(['apply', decisions]);
    expect(refreshNeeds({ dir, database, now: NOW })).toEqual({ due: 2, ungrouped: 0, goalsStale: true, unaligned: 2, needed: true });
    for (const groupId of [groupIdFor(key('a')), groupIdFor(key('c'))]) {
      const review = join(dir, 'review.json');
      writeFileSync(review, JSON.stringify({ groupId, state: 'in-progress', percent: 50, summary: 'Under way.', reviewBasis: run(['show', groupId]).reviewBasis }));
      run(['record-progress', review]);
    }
    const alignment = join(dir, 'alignment-input.json');
    writeFileSync(alignment, JSON.stringify({ links: [{ groupId: groupIdFor(key('a')), goal: 'Priority: Ship cards', evidence: 'Release cards are the cards to ship.' }], unaligned: [groupIdFor(key('c'))] }));
    expect(run(['record-alignment', alignment])).toEqual({ aligned: 1, unaligned: 1 });
    expect(refreshNeeds({ dir, database, now: NOW - 2 * DAY + 1000 })).toEqual({ due: 0, ungrouped: 0, goalsStale: false, unaligned: 0, needed: false });
    expect(run(['refresh-needs'], NOW - 2 * DAY + 1000).needed).toBe(false);
    // A goals update that keeps the same goals (new ranks, quotes or summary) needs no new alignment.
    saveGoals(database, new Date(NOW).toISOString());
    expect(refreshNeeds({ dir, database, now: NOW }).unaligned).toBe(0);
    // Ship cards is replaced by Pricing.
    const goalWrite = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
    goalWrite.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Ship cards', status: 'dropped' }), 3);
    goalWrite.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Pricing', status: 'todo', goal_kind: 'priority', rank: 1, title: 'Pricing' }), 4);
    expect(run(['align-input']).groups.map((group: { groupId: string }) => group.groupId)).toEqual([groupIdFor(key('a')), groupIdFor(key('c'))]);
    writeFileSync(alignment, JSON.stringify({ links: [{ groupId: groupIdFor(key('c')), goal: 'Priority: Pricing', evidence: 'The pricing page.' }], unaligned: [groupIdFor(key('a'))] }));
    run(['record-alignment', alignment]);
    expect(refreshNeeds({ dir, database, now: NOW }).unaligned).toBe(0);
    // A new goal: any group may serve it, so every group is asked (keeping its previous links).
    goalWrite.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Docs', status: 'todo', goal_kind: 'priority', rank: 2, title: 'Docs' }), 5);
    expect(refreshNeeds({ dir, database, now: NOW }).unaligned).toBe(2);
    writeFileSync(alignment, JSON.stringify({ links: [{ groupId: groupIdFor(key('c')), goal: 'Priority: Pricing', evidence: 'The pricing page.' }, { groupId: groupIdFor(key('a')), goal: 'Priority: Docs', evidence: 'Card docs.' }] }));
    run(['record-alignment', alignment]);
    // A goal that is gone: only the group linked to it is asked again.
    goalWrite.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Docs', status: 'dropped' }), 6);
    expect(run(['align-input']).groups.map((group: { groupId: string }) => group.groupId)).toEqual([groupIdFor(key('a'))]);
    const before = ledgerSignature(dir);
    writeFileSync(join(dir, 'refresh.json'), JSON.stringify({ state: 'running' }));
    expect(ledgerSignature(dir)).not.toBe(before);
    expect(readLedger(dir).refresh).toEqual({ state: 'running' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('readings: each review adds one dated percent, deduplicated by time and capped', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; } }); return output; };
    const decisions = join(dir, 'decisions.json');
    writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Pricing page', conversations: [key('c')] }] }));
    run(['apply', decisions]);
    const groupId = groupIdFor(key('c'));
    const review = (percent: number, now: number) => {
      const file = join(dir, 'review.json');
      writeFileSync(file, JSON.stringify({ groupId, state: 'in-progress', percent, summary: 'Under way.', reviewBasis: run(['show', groupId], now).reviewBasis }));
      return run(['record-progress', file], now);
    };
    expect(review(30, NOW).readings).toBe(1);
    expect(review(55, NOW + DAY).readings).toBe(2);
    expect(review(60, NOW + DAY).readings).toBe(2);
    expect(readLedger(dir).progress[groupId].readings).toEqual([{ at: new Date(NOW).toISOString(), percent: 30 }, { at: new Date(NOW + DAY).toISOString(), percent: 60 }]);
    let readings = readLedger(dir).progress[groupId];
    for (let index = 0; index < MAX_READINGS + 5; index++) readings = { readings: appendReading(readings, { at: new Date(NOW + (index + 2) * DAY).toISOString(), percent: index }) };
    expect(readings.readings.length).toBe(MAX_READINGS);
    expect(readings.readings.at(-1).percent).toBe(MAX_READINGS + 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('the snapshot joins alignment onto requests: linked, explicitly none, or not linked yet', () => {
  const source = new WorkStateSource({ ledgerDir: null });
  const goal = { id: '["owner","owner-goals"]-ship', task: 'Priority: Ship cards', title: 'Ship cards', kind: 'priority' };
  source.agentView = { ...source.agentView, goals: { generatedAt: '2026-10-01T10:00:00Z', priorities: [goal], openAsks: [] }, humanRequests: [{ id: 'r1', groupId: 'g_1' }, { id: 'r2', groupId: 'g_2' }, { id: 'r3', groupId: 'g_3' }, { id: 'r4', groupId: null }] } as any;
  source.ledger = { alignment: { links: { g_1: [{ goal: 'Priority: Ship cards', evidence: 'The cards.' }], g_3: [{ goal: 'Priority: Gone', evidence: 'An old goal.' }] }, unaligned: ['g_2'], goals: ['Priority: Ship cards', 'Priority: Gone'], alignedAt: '2026-10-02T00:00:00Z' } } as any;
  const { humanRequests, goals } = source.goalLinks() as any;
  expect(humanRequests[0].goals).toEqual([{ goalId: goal.id, goal: goal.task, title: 'Ship cards', kind: 'priority', evidence: 'The cards.' }]);
  expect(humanRequests[1].goals).toEqual([]);
  expect(humanRequests[2].goals).toBeUndefined();
  expect(humanRequests[3].goals).toBeUndefined();
  expect(goals.alignedAt).toBe('2026-10-02T00:00:00Z');
  // A newer goals run with the same goals keeps "serves none"; an added goal makes it a question again.
  source.agentView = { ...source.agentView, goals: { ...source.agentView.goals, generatedAt: '2026-10-05T10:00:00Z' } } as any;
  expect((source.goalLinks() as any).humanRequests[1].goals).toEqual([]);
  source.agentView = { ...source.agentView, goals: { ...source.agentView.goals, openAsks: [{ ...goal, id: 'new', task: 'Open ask: Docs', title: 'Docs', kind: 'open-ask' }] } } as any;
  expect((source.goalLinks() as any).humanRequests[1].goals).toBeUndefined();
});

});

function saveGoals(database: Database, generatedAt: string) {
  const write = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
  write.run('owner', 'owner-goals', JSON.stringify({ human_summary: 'Ship the cards.', generated_at: generatedAt }), 1);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Ship cards', status: 'todo', goal_kind: 'priority', rank: 1, title: 'Ship cards', evidence: '2026-10-01 10:00 | ship the cards | today' }), 2);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Open ask: Old thing', status: 'todo', goal_kind: 'open-ask', rank: 1, title: 'Old thing' }), 3);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Open ask: Old thing', status: 'dropped' }), 4);
  write.run('owner', 'owner-goals/2026-09-01', JSON.stringify({ task: 'Priority: History', status: 'done', title: 'History' }), 5);
}

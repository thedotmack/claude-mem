import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendReading, applyGroupDecisions, groupIdFor, ledgerSignature, linkBackwards, MAX_READINGS, readCandidates, readGoals, readLedger, refreshNeeds, runCli, validateProgress } from '../../src/services/work-view/request-groups.mjs';
import { readFocus, readFocusAreas } from '../../src/services/work-view/data-source.mjs';
import { focusAreaRowFields, placementRowFields, routerFocusRows, type RouterFocusBody } from '../../src/services/work-view/my-focus.mjs';
import { buildHumanRequests } from '../../src/services/work-view/request-projection.mjs';
import { scratchDir } from '../helpers/scratch-dir.js';

const ledgerDir = () => scratchDir('request-groups-test');
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
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
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
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
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
  expect(goals.goals.map((goal) => [goal.taskKey, goal.kind, goal.rank, goal.legacy])).toEqual([['Focus area: Ship cards', 'focus-area', 1, false]]);
  expect(goals.goals[0].evidence).toEqual([{ at: '2026-10-01 10:00', quote: 'ship the cards | today' }]);
});

  it('goals saved before the three tests read as the nearest new kind, marked legacy; an unknown kind is refused', () => {
  const database = fixtureDatabase();
  const write = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Ship cards', status: 'todo', goal_kind: 'priority', rank: 1, title: 'Ship cards' }), 1);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Open ask: Docs', status: 'todo', goal_kind: 'open-ask', rank: 1, title: 'Docs' }), 2);
  expect(readGoals(database).goals.map((goal) => [goal.taskKey, goal.kind, goal.legacy])).toEqual([['Priority: Ship cards', 'focus-area', true], ['Open ask: Docs', 'ask', true]]);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Rule: Tests', status: 'todo', goal_kind: 'rule', title: 'Tests' }), 3);
  expect(() => readGoals(database)).toThrow(/unknown goal_kind: "rule"/);
});

  it('focus round trip: focus-input lists areas and one batch of requests with every conversation\'s ask; record-focus writes router rows through the worker', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    const focus = focusFixture(database);
    focus.area('fa_cards', 'Cards', 'kept');
    const { run, write } = cliRunner(dir, database, focus.save);
    run(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    const input = run(['focus-input']);
    expect(input.areas).toEqual([{ focusAreaId: 'fa_cards', name: 'Cards', goal: 'Make Cards good.', about: 'Everything about Cards.', status: 'kept' }]);
    expect(input.requests.map((request: any) => [request.anchor, request.title, request.firstAsk, request.repo, request.conversations, request.conversationAsks]))
      .toEqual([[key('a'), 'Release cards', 'Build the release cards', 'repo', 2, ['Build the release cards', 'Fix the card spacing']], [key('c'), 'Pricing page', 'Write the pricing page', 'repo', 1, ['Write the pricing page']]]);
    expect(input.remaining).toBe(0);
    // Batches: --limit 1 lists the first request and counts the rest.
    expect(run(['focus-input', '--limit', '1'])).toMatchObject({ requests: [{ anchor: key('a') }], remaining: 1 });
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' }).unplaced).toBe(2);
    // An unknown area id is refused, never mapped to Other, and nothing is written.
    const rowsBefore = focus.rows();
    await expect(run(['record-focus', write('f0.json', { placements: [{ anchor: key('a'), focusAreaId: 'fa_nope', evidence: 'x' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'y' }], proposals: [] })])).rejects.toThrow(/"fa_nope", which is not a listed focus area/);
    await expect(run(['record-focus', write('f1.json', { placements: [{ anchor: key('a'), focusAreaId: 'fa_cards', evidence: 'x' }], proposals: [] })])).rejects.toThrow(/Place every request asked about; missing/);
    expect(focus.rows()).toBe(rowsBefore);
    // A batch answer is checked against that batch: the second request is not part of the --limit 1 question.
    await expect(run(['record-focus', '--limit', '1', write('f1b.json', { placements: [{ anchor: key('a'), focusAreaId: 'fa_cards', evidence: 'x' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'y' }], proposals: [] })])).rejects.toThrow(/was not asked about/);
    expect(await run(['record-focus', write('f2.json', { placements: [{ anchor: key('a'), focusAreaId: 'fa_cards', evidence: 'Release cards are cards.' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'Pricing fits no area.' }], proposals: [] })]))
      .toEqual({ placed: 2, proposed: 0, focusAreaIds: [] });
    const placed = readFocus(database, { localDeviceId: '' });
    expect(placed.focusAreaIdByAnchor.get(key('a'))).toBe('fa_cards');
    expect(placed.focusAreaIdByAnchor.get(key('c'))).toBe('other');
    expect(placed.placementsByAnchor.get(key('a'))?.router?.basis).toMatch(/^[0-9a-f]{16}$/);
    expect(run(['focus-input']).requests).toEqual([]);
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' }).unplaced).toBe(0);
    // Without the worker's write, or without the worker's device id, the command refuses instead of guessing.
    expect(() => runCli(['record-focus', write('f3.json', { placements: [], proposals: [] })], { dir, database, now: NOW, print: () => {}, localDeviceId: '' })).toThrow(/saves through the claude-mem worker/);
    expect(() => runCli(['focus-input'], { dir, database, now: NOW, print: () => {} })).toThrow(/sync device id/);
    expect(() => refreshNeeds({ dir, database, now: NOW } as any)).toThrow(/sync device id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('a request is placed again when its asks or conversations change, never for a new review; another device\'s placement is not compared', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    const focus = focusFixture(database);
    focus.area('fa_cards', 'Cards', 'kept');
    focus.area('fa_done', 'Launch', 'kept');
    const { run, write } = cliRunner(dir, database, focus.save);
    const group = groupIdFor(key('a'));
    run(['apply', write('d1.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    await run(['record-focus', write('f1.json', { placements: [{ anchor: key('a'), focusAreaId: 'fa_cards', evidence: 'The cards.' }, { anchor: key('c'), focusAreaId: 'fa_done', evidence: 'Pricing for the launch.' }], proposals: [] })]);
    expect(run(['focus-input']).requests).toEqual([]);
    // The owner finishes the Launch area; its requests stay there.
    focus.area('fa_done', 'Launch', 'done');
    // A new review (state, percent, summary) does not decide the area: nothing is queued, in a live or a done area.
    for (const groupId of [group, groupIdFor(key('c'))]) {
      run(['record-progress', write('r.json', { groupId, state: 'shipped', percent: 100, shippedAt: new Date(NOW).toISOString(), summary: 'Now something else entirely.', reviewBasis: run(['show', groupId]).reviewBasis })]);
    }
    expect(run(['focus-input']).requests).toEqual([]);
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' }).unplaced).toBe(0);
    // A merged-in conversation changes the request: it is placed again.
    run(['apply', write('d2.json', { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }] })]);
    expect(run(['focus-input']).requests.map((request: any) => request.anchor)).toEqual([key('a')]);
    // The same request placed by another computer, decided on that computer's copy: not re-placed here.
    focus.insert(placementRowFields({ anchorConversationKey: key('a'), focusAreaId: 'fa_cards', placedBy: 'router', basis: 'ffffffffffffffff', evidence: 'Placed elsewhere.' }), 'other-device');
    expect(run(['focus-input']).requests).toEqual([]);
    // A seed placement written without a basis counts as current.
    focus.insert(placementRowFields({ anchorConversationKey: key('c'), focusAreaId: 'fa_cards', placedBy: 'router', evidence: 'Seeded.' }));
    run(['apply', write('d3.json', { groups: [{ title: 'Pricing and plans', conversations: [key('c')] }] })]);
    expect(run(['focus-input']).requests).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('an owner placement is never queued while its area is live; once the owner dismisses that area it no longer binds', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    const focus = focusFixture(database);
    focus.area('fa_cards', 'Cards', 'kept');
    focus.area('fa_pricing', 'Pricing', 'suggested');
    const { run, write } = cliRunner(dir, database, focus.save);
    run(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    focus.insert(placementRowFields({ anchorConversationKey: key('c'), focusAreaId: 'fa_pricing', placedBy: 'owner', evidence: 'Moved by you in My Work.' }));
    expect(run(['focus-input']).requests.map((request: any) => request.anchor)).toEqual([key('a')]);
    run(['apply', write('d2.json', { groups: [{ title: 'Pricing and plans', conversations: [key('c')] }] })]);
    expect(run(['focus-input']).requests.map((request: any) => request.anchor)).toEqual([key('a')]);
    await expect(run(['record-focus', write('f.json', { placements: [{ anchor: key('a'), focusAreaId: 'fa_cards', evidence: 'x' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'y' }], proposals: [] })])).rejects.toThrow(/was not asked about/);
    focus.area('fa_pricing', 'Pricing', 'dismissed', 'owner');
    expect(run(['focus-input']).requests.map((request: any) => request.anchor)).toEqual([key('a'), key('c')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('placing promotes any request that holds several asks; sameAs on a listed area places there; a dismissed area is never placed in or proposed again', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    const focus = focusFixture(database);
    focus.area('fa_cards', 'Cards', 'kept');
    focus.area('fa_old', 'Billing', 'dismissed', 'owner');
    const { run, write } = cliRunner(dir, database, focus.save);
    run(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    const input = run(['focus-input']);
    expect(input.areas.map((area: any) => area.focusAreaId)).toEqual(['fa_cards']);
    expect(input.dismissed.map((area: any) => [area.focusAreaId, area.name])).toEqual([['fa_old', 'Billing']]);
    const placements = [{ anchor: key('a'), focusAreaId: 'fa_cards', evidence: 'Cards.' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'Pricing.' }];
    const promote = { kind: 'promote', name: 'Release', goal: 'Releases ship.', about: 'Cards, spacing and release work.', anchors: [key('a')], sameAs: null, evidence: 'Two separate asks: build cards, fix spacing.' };
    const refused = async (answer: unknown, pattern: RegExp, flags: string[] = []) => {
      const before = focus.rows();
      await expect(run(['record-focus', ...flags, write('f.json', answer)])).rejects.toThrow(pattern);
      expect(focus.rows()).toBe(before);
    };
    await refused({ placements: [{ ...placements[0], focusAreaId: 'fa_old' }, placements[1]], proposals: [] }, /fa_old \("Billing"\), which the owner dismissed/);
    await refused({ placements, proposals: [{ ...promote, sameAs: 'fa_old' }] }, /the area the owner dismissed .*never propose it again/);
    await refused({ placements, proposals: [{ ...promote, sameAs: 'fa_nope' }] }, /not a listed area/);
    await refused({ placements, proposals: [{ ...promote, kind: 'new', anchors: [key('a'), key('c')] }] }, /new areas are proposed from Other in their own question/);
    await refused({ placements, proposals: [{ ...promote, anchors: [key('a'), key('c')] }] }, /promotes one request/);
    // A request placed in a kept area can still be promoted: it holds several separate asks.
    const saved = await run(['record-focus', write('f.json', { placements, proposals: [promote] })]);
    expect(saved).toMatchObject({ placed: 2, proposed: 1 });
    expect(saved.focusAreaIds[0]).toMatch(/^fa_[0-9a-f]{12}$/);
    let after = readFocus(database, { localDeviceId: '' });
    expect(after.focusAreas.find((area) => area.focusAreaId === saved.focusAreaIds[0])).toMatchObject({ name: 'Release', status: 'suggested', source: 'promotion', decidedBy: 'system' });
    expect(after.focusAreaIdByAnchor.get(key('a'))).toBe(saved.focusAreaIds[0]);
    // sameAs naming a listed area: its requests go there and no area is added.
    run(['apply', write('d2.json', { groups: [{ title: 'Pricing and plans', conversations: [key('c')] }] })]);
    const areasBefore = after.focusAreas.length;
    expect(await run(['record-focus', write('f2.json', { placements: [{ anchor: key('c'), focusAreaId: 'other', evidence: 'x' }], proposals: [{ ...promote, name: 'Cards again', anchors: [key('c')], sameAs: 'fa_cards' }] })])).toMatchObject({ placed: 1, proposed: 0 });
    after = readFocus(database, { localDeviceId: '' });
    expect(after.focusAreas).toHaveLength(areasBefore);
    expect(after.focusAreaIdByAnchor.get(key('c'))).toBe('fa_cards');
    expect(after.focusAreas.find((area) => area.focusAreaId === 'fa_old')?.status).toBe('dismissed');
    // The worker refuses a placement or a sameAs into a dismissed area on its own, whatever the CLI checked.
    expect(() => routerFocusRows({ placements: [{ anchorConversationKey: key('a'), focusAreaId: 'fa_old', basis: '0123456789abcdef', evidence: 'x' }], proposals: [] }, readFocusAreas(database, { localDeviceId: '' }))).toThrow(/fa_old, which no longer takes requests/);
    expect(() => routerFocusRows({ placements: [], proposals: [{ kind: 'new', name: 'Billing', goal: 'g', about: 'a', evidence: 'e', sameAs: 'fa_old', requests: [{ anchorConversationKey: key('a'), basis: '0123456789abcdef' }] }] }, readFocusAreas(database, { localDeviceId: '' }))).toThrow(/owner dismissed; it is never proposed again/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('the Other pass clusters router-placed Other requests, leaves the owner\'s Other alone, and runs again only when that set changes', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(4, 'claude', 'd', 'm4', 'repo/tree', 'Tidy the card copy', NOW - DAY);
    database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(4, 1, 'Tidy the card copy', NOW - DAY);
    const focus = focusFixture(database);
    const { run, write } = cliRunner(dir, database, focus.save);
    run(['apply', write('d.json', { groups: ['a', 'b', 'c', 'd'].map((session) => ({ title: `Request ${session}`, conversations: [key(session)] })) })]);
    // The owner put d in Other themselves; the router put a, b and c there.
    focus.insert(placementRowFields({ anchorConversationKey: key('d'), focusAreaId: 'other', placedBy: 'owner', evidence: 'Moved by you in My Work.' }));
    await run(['record-focus', write('f.json', { placements: ['a', 'b', 'c'].map((session) => ({ anchor: key(session), focusAreaId: 'other', evidence: 'Fits no area.' })), proposals: [] })]);
    const needs = refreshNeeds({ dir, database, now: NOW, localDeviceId: '' });
    expect([needs.unplaced, needs.otherChanged]).toEqual([0, true]);
    const other = run(['focus-input', '--other']);
    expect(other.due).toBe(true);
    expect(other.other.map((request: any) => request.anchor)).toEqual([key('a'), key('b'), key('c')]);
    const cluster = { kind: 'new', name: 'Polish', goal: 'The release looks finished.', about: 'Spacing and copy fixes.', anchors: [key('b'), key('c')], sameAs: null, evidence: 'Both are steps of finishing the release.' };
    await expect(run(['record-focus', '--other', write('o0.json', { placements: [{ anchor: key('a'), focusAreaId: 'other', evidence: 'x' }], proposals: [] })])).rejects.toThrow(/places nothing/);
    await expect(run(['record-focus', '--other', write('o1.json', { placements: [], proposals: [{ ...cluster, anchors: [key('b'), key('d')] }] })])).rejects.toThrow(/not a listed Other request/);
    await expect(run(['record-focus', '--other', write('o2.json', { placements: [], proposals: [{ ...cluster, anchors: [key('b')] }] })])).rejects.toThrow(/clusters one request/);
    const saved = await run(['record-focus', '--other', write('o3.json', { placements: [], proposals: [cluster] })]);
    expect(saved).toMatchObject({ placed: 2, proposed: 1 });
    const after = readFocus(database, { localDeviceId: '' });
    expect(after.focusAreas[0]).toMatchObject({ name: 'Polish', status: 'suggested', source: 'clustering' });
    expect([key('b'), key('c'), key('d')].map((anchor) => after.focusAreaIdByAnchor.get(anchor))).toEqual([saved.focusAreaIds[0], saved.focusAreaIds[0], 'other']);
    // The pass looked at what is left in Other (a): a quiet refresh does not ask again.
    expect(run(['focus-input', '--other']).due).toBe(false);
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' }).otherChanged).toBe(false);
    // An empty answer still records the pass.
    focus.insert(placementRowFields({ anchorConversationKey: key('b'), focusAreaId: 'other', placedBy: 'router', basis: null as any, evidence: 'Back to Other.' }));
    expect(run(['focus-input', '--other']).due).toBe(true);
    await run(['record-focus', '--other', write('o4.json', { placements: [], proposals: [] })]);
    expect(run(['focus-input', '--other']).due).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('the Other pass runs again when a request in Other changes and is placed back in Other', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    const focus = focusFixture(database);
    const { run, write } = cliRunner(dir, database, focus.save);
    run(['apply', write('d.json', { groups: ['a', 'b'].map((session) => ({ title: `Request ${session}`, conversations: [key(session)] })) })]);
    await run(['record-focus', write('f.json', { placements: ['a', 'b'].map((session) => ({ anchor: key(session), focusAreaId: 'other', evidence: 'Fits no area.' })), proposals: [] })]);
    await run(['record-focus', '--other', write('o.json', { placements: [], proposals: [] })]);
    expect(run(['focus-input', '--other']).due).toBe(false);
    // Another computer's pass record syncs in, newer, over its own local titles: it is not this computer's pass.
    focus.insert({ other_pass_hash: 'another-computers-basis' }, 'other-computer');
    expect(run(['focus-input', '--other']).due).toBe(false);
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' }).otherChanged).toBe(false);
    // Request a changes: the placing step looks at it again and leaves it in Other. The same two requests are in
    // Other, but a holds something the last proposal pass never saw.
    run(['apply', write('d2.json', { groups: [{ title: 'Request a, now with pricing', conversations: [key('a')] }] })]);
    expect(run(['focus-input']).requests.map((request: any) => request.anchor)).toEqual([key('a')]);
    await run(['record-focus', write('f2.json', { placements: [{ anchor: key('a'), focusAreaId: 'other', evidence: 'Still fits no area.' }], proposals: [] })]);
    expect(run(['focus-input', '--other']).due).toBe(true);
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' }).otherChanged).toBe(true);
    await run(['record-focus', '--other', write('o2.json', { placements: [], proposals: [] })]);
    expect(run(['focus-input', '--other']).due).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('a re-review that adds an owner preference, a ship date fix or a regression reaches the story, at the same state and percent', () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    let output: any;
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
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
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
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
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
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
    // Rules owner-goals put in the story are carried by record-story but never shown to the story model, so it
    // cannot echo copies of them back without their source.
    const ownerGoalsRule = { preference: 'Ship daily.', when: '', kind: 'directive', supportCount: 1, quotes: [], source: 'owner-goals' };
    writeFileSync(join(dir, 'story.json'), JSON.stringify({ ...readLedger(dir).story, preferences: [{ preference: 'Keep the design.', quotes: [] }, ownerGoalsRule] }));
    expect(run(['story-input']).previousStory.preferences.map((preference: { preference: string }) => preference.preference)).toEqual(['Keep the design.']);
    run(['record-story', write('s3.json', { narrative: 'Two requests under way.', preferences: [{ preference: 'Keep the design.' }] })], NOW + 4000);
    expect(readLedger(dir).story.preferences.map((preference: { preference: string; source?: string }) => [preference.preference, preference.source ?? null]))
      .toEqual([['Keep the design.', null], ['Ship daily.', 'owner-goals']]);
    // The agent gets its budget up front, and an over-long story is refused with its length.
    expect(input).toMatchObject({ narrativeLimit: 12000, previousNarrativeChars: 'Two requests under way.'.length, roomChars: 12000 - 'Two requests under way.'.length });
    expect(() => run(['record-story', write('s.json', { narrative: 'x'.repeat(12001) })])).toThrow('narrative is 12001 characters; it must be 1–12000. Cut at least 1 characters.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

  it('a refresh is needed for due reviews, stale goals or unplaced requests, and not otherwise', async () => {
  const dir = ledgerDir();
  try {
    const database = fixtureDatabase();
    const focus = focusFixture(database);
    const { run, write } = cliRunner(dir, database, focus.save);
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' })).toEqual({ due: 0, ungrouped: 3, goalsStale: true, unplaced: 0, otherChanged: false, needed: true });
    saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
    run(['apply', write('decisions.json', { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b')], evidence: 'work list "release-cards" in repo/tree' }] }, { title: 'Pricing page', conversations: [key('c')] }] })]);
    // With no focus areas at all, every request still needs a place (Other, or an area the step proposes).
    expect(refreshNeeds({ dir, database, now: NOW, localDeviceId: '' })).toEqual({ due: 2, ungrouped: 0, goalsStale: true, unplaced: 2, otherChanged: false, needed: true });
    for (const groupId of [groupIdFor(key('a')), groupIdFor(key('c'))]) {
      run(['record-progress', write('review.json', { groupId, state: 'in-progress', percent: 50, summary: 'Under way.', reviewBasis: run(['show', groupId]).reviewBasis })]);
    }
    await run(['record-focus', write('focus.json', { placements: [{ anchor: key('a'), focusAreaId: 'other', evidence: 'Cards.' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'Pricing.' }], proposals: [] })]);
    // Two requests newly in Other: the proposal pass is due until it has looked at them.
    expect(refreshNeeds({ dir, database, now: NOW - 2 * DAY + 1000, localDeviceId: '' })).toMatchObject({ otherChanged: true, needed: true });
    await run(['record-focus', '--other', write('other.json', { placements: [], proposals: [] })]);
    expect(refreshNeeds({ dir, database, now: NOW - 2 * DAY + 1000, localDeviceId: '' })).toEqual({ due: 0, ungrouped: 0, goalsStale: false, unplaced: 0, otherChanged: false, needed: false });
    expect(run(['refresh-needs'], NOW - 2 * DAY + 1000).needed).toBe(false);
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
    const run = (argv: string[], now = NOW) => { runCli(argv, { dir, database, now, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
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

});

function saveGoals(database: Database, generatedAt: string) {
  const write = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
  write.run('owner', 'owner-goals', JSON.stringify({ human_summary: 'Ship the cards.', generated_at: generatedAt }), 1);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Focus area: Ship cards', status: 'todo', goal_kind: 'focus-area', rank: 1, title: 'Ship cards', evidence: '2026-10-01 10:00 | ship the cards | today' }), 2);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Ask: Old thing', status: 'todo', goal_kind: 'ask', rank: 1, title: 'Old thing' }), 3);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Ask: Old thing', status: 'dropped' }), 4);
  write.run('owner', 'owner-goals/2026-09-01', JSON.stringify({ task: 'Focus area: History', status: 'done', title: 'History' }), 5);
}

/** My Focus rows in the fixture database, written the way the worker writes them (routerFocusRows for the focus step). */
function focusFixture(database: Database) {
  database.exec('ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT');
  let at = 1000;
  const insertRow = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch, origin_device_id) VALUES (?, ?, ?, ?, ?)');
  const insert = (fields: Record<string, unknown>, device: string | null = null) => { insertRow.run('home', 'my-focus', JSON.stringify(fields), at++, device); };
  return {
    insert,
    area(focusAreaId: string, name: string, status: 'suggested' | 'kept' | 'dismissed', decidedBy: 'owner' | 'system' = status === 'suggested' ? 'system' : 'owner') {
      insert(focusAreaRowFields({ focusAreaId, name, goal: `Make ${name} good.`, about: `Everything about ${name}.`, status, priorityRank: 1, ownerRank: null, source: 'seed', mergedInto: null, evidence: null, decidedBy }));
    },
    rows: () => (database.prepare("SELECT COUNT(*) AS count FROM work_state_entries WHERE list_name = 'my-focus'").get() as { count: number }).count,
    save(body: RouterFocusBody) {
      const planned = routerFocusRows(body, readFocusAreas(database, { localDeviceId: '' }));
      for (const fields of planned.rows) insert(fields);
      return { placed: planned.placed, focusAreaIds: planned.focusAreaIds };
    },
  };
}

/** The CLI against the fixture; record-focus resolves its output (a refusal rejects). */
function cliRunner(dir: string, database: Database, saveFocus: (body: RouterFocusBody) => { placed: number; focusAreaIds: string[] }) {
  let output: any;
  const options = (now: number) => ({ dir, database, now, print: (value: unknown) => { output = value; }, saveFocus, localDeviceId: '' });
  const run = (argv: string[], now = NOW): any => argv[0] === 'record-focus'
    ? Promise.resolve().then(() => runCli(argv, options(now))).then(() => output)
    : (runCli(argv, options(now)), output);
  const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  return { run, write };
}

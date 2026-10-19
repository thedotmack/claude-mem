import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGroupDecisions, groupIdFor, linkBackwards, readCandidates, readLedger, runCli, validateProgress } from '../../src/services/work-view/request-groups.mjs';
import { buildHumanRequests } from '../../src/services/work-view/request-projection.mjs';
import { progressMeter, velocity } from '../../src/ui/work-view/view-model.js';
import { meter, parsePersonalRoute, personalRoute, storyPanel } from '../../src/ui/work-view/request-views.js';

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
  expect(linked.links[0].evidence).toBe('work list "release-cards"');
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
  const base = { groupId: 'g_000000000001', state: 'shipped', percent: 100, startedAt: '2026-10-01T00:00:00Z', shippedAt: '2026-10-03T00:00:00Z', summary: 'Cards merged and released.' };
  expect(validateProgress(base, groups).state).toBe('shipped');
  expect(() => validateProgress({ ...base, percent: 90 }, groups)).toThrow(/percent 100/);
  expect(() => validateProgress({ ...base, state: 'in-progress', percent: 50 }, groups)).toThrow(/Only a shipped/);
  expect(() => validateProgress({ ...base, groupId: 'g_ffffffffffff' }, groups)).toThrow(/Unknown group/);
  expect(() => validateProgress({ ...base, preferences: [{ kind: 'vibe', preference: 'x', quote: 'y' }] }, groups)).toThrow(/kind/);
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
    writeFileSync(review, JSON.stringify({ groupId, state: 'in-progress', percent: 70, startedAt: new Date(NOW - 3 * DAY).toISOString(), summary: 'Cards built; spacing fix in review.', preferences: [{ kind: 'directive', preference: 'Execute clear asks without asking.', quote: 'just do it', at: null }] }));
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

  it('meter labels and velocity come from reviews, never from recorded status', () => {
  expect(progressMeter(null)).toBe(null);
  expect(progressMeter({ state: 'shipped', percent: 100, startedAt: '2026-10-01T00:00:00Z', shippedAt: '2026-10-03T06:00:00Z' }).label).toMatch(/^Shipped .* · took 2d 6h$/);
  expect(progressMeter({ state: 'in-progress', percent: 40, startedAt: '2026-10-01T00:00:00Z' }).label).toMatch(/^40% · started /);
  const now = Date.parse('2026-10-19T00:00:00Z');
  const stats = velocity([
    { state: 'shipped', percent: 100, startedAt: '2026-10-15T00:00:00Z', shippedAt: '2026-10-16T00:00:00Z' },
    { state: 'shipped', percent: 100, startedAt: '2026-09-20T00:00:00Z', shippedAt: '2026-09-23T00:00:00Z' },
    { state: 'in-progress', percent: 50 }, { state: 'stalled', percent: 30 },
  ], now);
  expect(stats.shipped7).toBe(1);
  expect(stats.shipped30).toBe(2);
  expect(stats.medianCycleMs).toBe(2 * DAY);
  expect(stats.inProgress).toBe(1);
  expect(stats.weekly.at(-1).count).toBe(1);
});

  it('renders the meter and the Story view from reviews, with an empty state', () => {
    expect(meter({ progress: null })).toBe('');
    expect(meter({ progress: { state: 'in-progress', percent: 40 } })).toContain('aria-valuenow="40"');
    expect(parsePersonalRoute('#story').view).toBe('story');
    expect(personalRoute('story')).toBe('#story');
    expect(storyPanel(null)).toContain('No build story yet');
    const html = storyPanel({ groups: 2, reviews: [{ title: 'Cards <b>', summary: 'Merged.', state: 'shipped', percent: 100, startedAt: '2026-10-01T00:00:00Z', shippedAt: '2026-10-02T00:00:00Z' }], story: { narrative: '## Week one\n\nShipped cards.', preferences: [{ preference: 'Execute clear asks.', kind: 'directive', supportCount: 2, quotes: [{ quote: 'just do it', at: null }] }] } });
    expect(html).toContain('<h3>Week one</h3>');
    expect(html).toContain('Cards &lt;b&gt;');
    expect(html).toContain('seen 2×');
  });
});

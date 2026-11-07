import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentView, readAgentRecords } from '../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import { buildRefreshTask } from '../../src/services/work-view/refresh-task.js';
import { applyGroupDecisions, groupIdFor, groupingInput, linkBackwards, readCandidates, readLedger, runCli, validateGroupingAnswer } from '../../src/services/work-view/request-groups.mjs';
import { buildHumanRequests } from '../../src/services/work-view/request-projection.mjs';
import { NO_PROJECT, pathsIn, projectFromToolPaths, withDerivedProjects, projectRoot, upgradedGroupRoot } from '../../src/services/work-view/session-project.mjs';
import { everyRequestInOther, focusWriter } from '../helpers/fake-focus-writer.js';

const DAY = 86400000, NOW = 100 * DAY;
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const overall = (anchor: string) => JSON.stringify(['overall-request', groupIdFor(key(anchor))]);
const session = (id: number, content: string, project: string, ask: string, at = id * 10) => ({ id, platform_source: 'claude', content_session_id: content, project, user_prompt: ask, started_at_epoch: at });
const prompt = (id: number, sessionId: number, text: string, at: number, number = 1) => ({ id, session_db_id: sessionId, prompt_number: number, prompt_text: text, created_at_epoch: at });
const link = (conversations: string[]) => [{ kind: 'agent-judgment', conversations, evidence: 'the later ask continues the earlier one' }];

/** sdk_sessions and tool_uses with the cwd columns real databases have. */
function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER, cwd TEXT, custom_title TEXT, status TEXT, completed_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, cwd TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  return db;
}
const addSession = (db: Database, id: number, content: string, project: string, ask: string, at: number, cwd: string | null = null) => {
  db.prepare('INSERT INTO sdk_sessions (id, platform_source, content_session_id, memory_session_id, project, user_prompt, started_at_epoch, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'claude', content, `m${id}`, project, ask, at, cwd);
  db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(id, 1, ask, at);
};

describe('a human request is the top level', () => {
  it('cards come from prompts: a group with no work and an ungrouped ask each show, with their asks', () => {
    const ledger = { groups: { conversations: { [key('a')]: groupIdFor(key('a')), [key('b')]: groupIdFor(key('a')) }, groups: { [groupIdFor(key('a'))]: { title: 'Release cards', anchor: key('a'), projectRoot: 'repo' } }, ignored: { [key('bot')]: 'naming prompt' } }, progress: {} };
    const sessions = [session(1, 'a', 'repo', 'Build the release cards'), session(2, 'b', 'repo/tree', 'Fix the card spacing'), session(3, 'c', 'repo', 'Write the pricing page'), session(4, 'bot', 'repo', 'Name this workspace from the prompt'), session(5, 'hi', 'repo', 'hi')];
    const prompts = [prompt(11, 1, 'Build the release cards', 10), prompt(21, 2, 'Fix the card spacing', 20), prompt(22, 2, 'Keep the old colors', 25, 2), prompt(31, 3, 'Write the pricing page', 30)];
    const { humanRequests, unlinkedWork } = buildHumanRequests({ agents: [] }, { sessions, prompts }, { ledger });
    expect(humanRequests.map((request: any) => request.id).sort()).toEqual([key('c'), overall('a')].sort());
    const cards = humanRequests.find((request: any) => request.groupId);
    expect(cards.title).toBe('Release cards');
    expect(cards.original.sourceId).toBe(11);
    expect(cards.items).toEqual([]);
    expect(cards.activity).toEqual([]);
    expect(cards.scopeUpdates.map((update: any) => update.sourceId)).toEqual([21, 22]);
    expect(cards.updatedAtEpoch).toBe(25);
    expect(unlinkedWork).toEqual([]);
    // No prompts at all: no cards, so "No requests recorded yet" means nothing was asked.
    expect(buildHumanRequests({ agents: [] }, { sessions: [], prompts: [] }).humanRequests).toEqual([]);
  });

  it('a group whose conversations aged out still shows from its stored first ask', () => {
    const anchorAsk = { text: 'Build the release cards', source: 'user-prompt', sourceId: 11, url: '/api/work-view/evidence/prompt/11', promptNumber: 1, atEpoch: 10 };
    const ledger = { groups: { conversations: { [key('a')]: groupIdFor(key('a')) }, groups: { [groupIdFor(key('a'))]: { title: 'Release cards', anchor: key('a'), anchorAsk } }, ignored: {} }, progress: { [groupIdFor(key('a'))]: { state: 'in-progress', percent: 30 } } };
    const [request] = buildHumanRequests({ agents: [] }, { sessions: [], prompts: [] }, { ledger }).humanRequests;
    expect(request.id).toBe(overall('a'));
    expect(request.original).toEqual(anchorAsk);
    expect(request.progress.percent).toBe(30);
  });

  it('recorded work, its activity and its agent attach beneath the request built from the prompt', () => {
    const sessions = [session(1, 'a', 'repo', 'Build the release cards')];
    const prompts = [prompt(11, 1, 'Build the release cards', 10)];
    const work = { id: 'w1', title: 'Card grid', kind: 'work-state', listId: 'cards', listName: 'cards', project: 'repo', status: 'doing', lastUpdateEpoch: 50, sourceRefs: [{ kind: 'work-state', id: 9 }] };
    const view = { agents: [{ id: 'agent-1', label: 'Claude Code', sessionId: 1, work: [work], activity: [{ id: 'work-state:9', kind: 'work-state', title: 'Card grid', atEpoch: 50 }] }] };
    const { humanRequests } = buildHumanRequests(view, { sessions, prompts });
    expect(humanRequests.length).toBe(1);
    expect(humanRequests[0].id).toBe(key('a'));
    expect(humanRequests[0].items.map((item: any) => item.id)).toEqual(['w1']);
    expect(humanRequests[0].activity.map((activity: any) => activity.id)).toEqual(['work-state:9']);
    expect(humanRequests[0].agentIds).toEqual(['agent-1']);
    expect(humanRequests[0].updatedAtEpoch).toBe(50);
    // An agent with no work yet still names who is on the request.
    const idle = buildHumanRequests({ agents: [{ id: 'agent-1', label: 'Claude Code', sessionId: 1, work: [] }] }, { sessions, prompts }).humanRequests[0];
    expect(idle.agentIds).toEqual(['agent-1']);
  });

  it('a fresh install with only prompts shows cards through the real read path', () => {
    const db = database();
    addSession(db, 1, 'a', 'repo', 'Build the release cards', NOW - DAY);
    addSession(db, 2, 'b', 'repo', 'Write the pricing page', NOW - 2 * DAY);
    const state = reduceWorkState([], { currentProject: 'repo' });
    const view = buildAgentView(state, readAgentRecords(db, { workState: state, now: NOW }), { now: NOW });
    expect(view.humanRequests.map((request: any) => request.original.text).sort()).toEqual(['Build the release cards', 'Write the pricing page']);
  });
});

describe('requests stay inside one project root', () => {
  it('apply refuses a cross-root join, in code and through the CLI', () => {
    const projectOf = new Map([[key('a'), 'repo-one'], [key('b'), 'repo-two']]);
    expect(() => applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }, NOW, { projectOf })).toThrow(/different projects \(repo-one, repo-two\)/);
    // Continuing an existing group checks the members it already holds.
    const first = applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a')] }] }, NOW, { projectOf });
    expect(first.groups[groupIdFor(key('a'))].projectRoot).toBe('repo-one');
    expect(() => applyGroupDecisions(first, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }, NOW, { projectOf: new Map([[key('b'), 'repo-two']]) })).toThrow(/different projects/);
    const dir = mkdtempSync(join(tmpdir(), 'request-first-'));
    try {
      const db = database();
      addSession(db, 1, 'a', 'repo-one', 'Build the release cards', NOW - 2 * DAY);
      addSession(db, 2, 'b', 'repo-two', 'Continue the release cards', NOW - DAY);
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }));
      expect(() => runCli(['apply', decisions], { dir, database: db, now: NOW, print: () => {} })).toThrow(/different projects/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a decision that names the request\'s projectRoot joins conversations from other roots and records that root', () => {
    const projectOf = new Map([[key('a'), 'repo-one'], [key('b'), 'repo-two']]);
    const decision = { title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) };
    const joined = applyGroupDecisions(null, { groups: [{ ...decision, projectRoot: 'repo-one' }] }, NOW, { projectOf });
    expect(joined.conversations[key('b')]).toBe(groupIdFor(key('a')));
    expect(joined.groups[groupIdFor(key('a'))].projectRoot).toBe('repo-one');
    // A later decision's root replaces the stored one; an empty or non-string root is refused.
    expect(applyGroupDecisions(joined, { groups: [{ ...decision, projectRoot: 'repo-two' }] }, NOW, { projectOf }).groups[groupIdFor(key('a'))].projectRoot).toBe('repo-two');
    // A refresh answer cannot name a root, so a later conversation from the saved root still joins the group.
    const grown = applyGroupDecisions(joined, { groups: [{ title: 'Cards', conversations: [key('a'), key('c')], links: link([key('a'), key('c')]) }] }, NOW, { projectOf: new Map([...projectOf, [key('c'), 'repo-one']]) });
    expect(grown.conversations[key('c')]).toBe(groupIdFor(key('a')));
    expect(grown.conversations[key('b')]).toBe(groupIdFor(key('a')));
    expect(grown.groups[groupIdFor(key('a'))]).toMatchObject({ projectRoot: 'repo-one', rootNamed: true });
    expect(() => applyGroupDecisions(null, { groups: [{ ...decision, projectRoot: ' ' }] }, NOW, { projectOf })).toThrow(/projectRoot must be a non-empty string/);
    expect(() => applyGroupDecisions(null, { groups: [{ ...decision, projectRoot: 7 }] }, NOW, { projectOf })).toThrow(/projectRoot must be a non-empty string/);
    const dir = mkdtempSync(join(tmpdir(), 'request-first-'));
    try {
      const db = database();
      addSession(db, 1, 'a', 'repo-one', 'Build the release cards', NOW - 2 * DAY);
      addSession(db, 2, 'b', 'repo-two', 'Continue the release cards', NOW - DAY);
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: [{ ...decision, projectRoot: 'repo-one' }] }));
      let output: any;
      runCli(['apply', decisions], { dir, database: db, now: NOW, print: (value: unknown) => { output = value; } });
      expect(output).toEqual({ groups: 1, conversations: 2 });
      expect(readLedger(dir).groups.groups[groupIdFor(key('a'))].projectRoot).toBe('repo-one');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('worktrees of one repo group together and link through a shared list or request id', () => {
    const projectOf = new Map([[key('a'), 'repo/tree-a'], [key('b'), 'repo/tree-b']]);
    const merged = applyGroupDecisions(null, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }, NOW, { projectOf });
    expect(merged.conversations[key('b')]).toBe(groupIdFor(key('a')));
    expect(merged.groups[groupIdFor(key('a'))].projectRoot).toBe('repo');
    const candidate = (id: string, project: string, extra: object) => ({ conversationKey: key(id), project, workLists: [], requestIds: [], ...extra });
    const lists = linkBackwards([candidate('a', 'repo/tree-a', { workLists: ['cards'] }), candidate('b', 'repo/tree-b', { workLists: ['cards'] }), candidate('c', 'other', { workLists: ['cards'] })]);
    expect(lists.proposedGroups.map((group: any) => group.conversations)).toEqual([[key('a'), key('b')], [key('c')]]);
    const ids = linkBackwards([candidate('a', 'repo/tree-a', { requestIds: ['r-1'] }), candidate('c', 'other', { requestIds: ['r-1'] })]);
    expect(ids.proposedGroups.every((group: any) => group.conversations.length === 1)).toBe(true);
  });

  it('the projection keeps every conversation assigned to a group with a recorded root, checks the root only when none was recorded, and names one explicit request per root', () => {
    const groupId = groupIdFor(key('a'));
    const ledgerWith = (projectRoot: string | null, ignored = {}) => ({ groups: { conversations: { [key('a')]: groupId, [key('b')]: groupId }, groups: { [groupId]: { title: 'Cards', anchor: key('a'), projectRoot } }, ignored }, progress: {} });
    const sessions = [session(1, 'a', 'repo-one/tree', 'Build the release cards'), session(2, 'b', 'repo-two', 'Fix the card spacing')];
    const prompts = [prompt(11, 1, 'Build the release cards', 10), prompt(21, 2, 'Fix the card spacing', 20)];
    const requests = (ledger: object) => buildHumanRequests({ agents: [] }, { sessions, prompts }, { ledger }).humanRequests;
    // b worked in repo-two, but the request's root is recorded: the ledger's assignment stands and b joins the card.
    expect(requests(ledgerWith('repo-one')).map((request: any) => [request.id, request.conversationKeys])).toEqual([[overall('a'), [key('a'), key('b')]]]);
    // No root recorded: the anchor's root decides, so b stays its own card.
    expect(requests(ledgerWith(null)).map((request: any) => request.id).sort()).toEqual([key('b'), overall('a')].sort());
    // An ignored conversation stays out, whatever root the group recorded.
    expect(requests(ledgerWith('repo-one', { [key('b')]: 'naming prompt' })).map((request: any) => [request.id, request.conversationKeys])).toEqual([[overall('a'), [key('a')]]]);
    const item = (id: string, project: string) => ({ id, title: id, kind: 'work-state', listId: id, project, requestId: 'r-1', lastUpdateEpoch: 1 });
    const view = { agents: [{ id: 'x', label: 'Codex', sessionId: 1, work: [item('one', 'repo-one/tree')] }, { id: 'y', label: 'Codex', sessionId: 2, work: [item('two', 'repo-two')] }] };
    const explicit = buildHumanRequests(view, { sessions, prompts }).humanRequests;
    expect(explicit.map((request: any) => request.id).sort()).toEqual([JSON.stringify(['explicit-request', 'repo-one', 'r-1']), JSON.stringify(['explicit-request', 'repo-two', 'r-1'])]);
  });
});

describe('a group decided before its project was known', () => {
  it('keeps its conversations once tool calls reveal the repository, and re-applies under the known root', () => {
    const groupId = groupIdFor(key('a'));
    // Grouped while the scratch-folder session had touched no repository: the "no project" root.
    const ledger = { groups: { conversations: { [key('a')]: groupId }, groups: { [groupId]: { title: 'Cards', anchor: key('a'), projectRoot: NO_PROJECT } }, ignored: {} }, progress: {} };
    // Its tool calls have since worked inside "repo".
    const sessions = [session(1, 'a', 'repo', 'Build the release cards')];
    const prompts = [prompt(11, 1, 'Build the release cards', 10)];
    expect(buildHumanRequests({ agents: [] }, { sessions, prompts }, { ledger }).humanRequests.map((request: any) => request.id)).toEqual([overall('a')]);
    const reapplied = applyGroupDecisions(ledger.groups, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }, NOW, { projectOf: new Map([[key('a'), 'repo'], [key('b'), 'repo/tree']]) });
    expect(reapplied.groups[groupId].projectRoot).toBe('repo');
    // A known root is still never mixed with another one.
    const known = { ...ledger.groups, groups: { [groupId]: { ...ledger.groups.groups[groupId], projectRoot: 'repo' } } };
    expect(() => applyGroupDecisions(known, { groups: [{ title: 'Cards', conversations: [key('a')] }] }, NOW, { projectOf: new Map([[key('a'), 'other']]) })).toThrow(/different projects/);
  });

  it('never joins two repositories: members that went to different repos are not one request', () => {
    const groupId = groupIdFor(key('a'));
    const ledger = { groups: { conversations: { [key('a')]: groupId, [key('b')]: groupId, [key('c')]: groupId }, groups: { [groupId]: { title: 'Cards', anchor: key('a'), projectRoot: NO_PROJECT } }, ignored: {} }, progress: {} };
    // a and c later worked in repo-one, b in repo-two.
    const sessions = [session(1, 'a', 'repo-one', 'Build the release cards'), session(2, 'b', 'repo-two', 'Fix the card spacing'), session(3, 'c', 'repo-one/tree', 'Add the card dates')];
    const prompts = [prompt(11, 1, 'Build the release cards', 10), prompt(21, 2, 'Fix the card spacing', 20), prompt(31, 3, 'Add the card dates', 30)];
    const ids = buildHumanRequests({ agents: [] }, { sessions, prompts }, { ledger }).humanRequests.map((request: any) => request.id).sort();
    expect(ids).toEqual([key('b'), overall('a')].sort());
    // With the anchor still in no repo, the one repo its members went to is the group's.
    const stillScratch = [session(1, 'a', NO_PROJECT, 'Build the release cards'), session(2, 'b', 'repo-two', 'Fix the card spacing')];
    const both = { ...ledger, groups: { ...ledger.groups, conversations: { [key('a')]: groupId, [key('b')]: groupId } } };
    expect(buildHumanRequests({ agents: [] }, { sessions: stillScratch, prompts }, { ledger: both }).humanRequests.map((request: any) => request.id)).toEqual([overall('a')]);
  });

  it('is offered as an open request to the root it now belongs to', () => {
    const db = database();
    addSession(db, 1, 'a', 'repo', 'Build the release cards', NOW - 3 * DAY);
    addSession(db, 2, 'b', 'repo', 'Continue the release cards', NOW - DAY);
    const dir = mkdtempSync(join(tmpdir(), 'request-first-'));
    try {
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: { [key('a')]: groupIdFor(key('a')) }, groups: { [groupIdFor(key('a'))]: { title: 'Release cards', anchor: key('a'), projectRoot: NO_PROJECT } }, ignored: {} }));
      const input = groupingInput(readLedger(dir), db, { sinceEpoch: NOW - 14 * DAY });
      expect(input.root).toBe('repo');
      expect(input.openRequests.map((request: any) => request.anchor)).toEqual([key('a')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('every open request of the root is offered', () => {
  it('an older request linked by a shared list can still take a follow-up, however many requests are open', () => {
    const db = database();
    const groups: Record<string, unknown> = {}, conversations: Record<string, string> = {};
    // The linked request is the oldest of 20 open ones.
    for (let index = 0; index < 20; index++) {
      const id = `s${index}`;
      addSession(db, index + 1, id, 'repo', `Build feature number ${index}`, NOW - (40 - index) * 3600000);
      groups[groupIdFor(key(id))] = { title: `Feature ${index}`, anchor: key(id), projectRoot: 'repo' };
      conversations[key(id)] = groupIdFor(key(id));
    }
    db.prepare('INSERT INTO tool_uses (session_db_id, tool_name, tool_input, created_at_epoch) VALUES (?, ?, ?, ?)').run(1, 'mcp__work_state_write', JSON.stringify({ list: 'feature-zero', fields: { task: 'x' } }), NOW - 40 * 3600000);
    addSession(db, 100, 'new', 'repo', 'Continue feature zero', NOW - 3600000);
    db.prepare('INSERT INTO tool_uses (session_db_id, tool_name, tool_input, created_at_epoch) VALUES (?, ?, ?, ?)').run(100, 'mcp__work_state_write', JSON.stringify({ list: 'feature-zero', fields: { task: 'y' } }), NOW - 3600000);
    const dir = mkdtempSync(join(tmpdir(), 'request-first-'));
    try {
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations, groups, ignored: {} }));
      const input = groupingInput(readLedger(dir), db, { sinceEpoch: NOW - 14 * DAY });
      expect(input.proposedLinks.map((proposed: any) => proposed.groups)).toEqual([[groupIdFor(key('s0'))]]);
      expect(input.openRequests).toHaveLength(20);
      const answer = { groups: [{ title: 'Feature 0', conversations: [key('s0'), key('new')], links: input.proposedLinks }] };
      expect(() => validateGroupingAnswer(answer, input)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('only new opening prompts are checked', () => {
  function ledgerFixture() {
    const db = database();
    addSession(db, 1, 'a', 'repo/tree', 'Build the release cards', NOW - 5 * DAY);
    addSession(db, 2, 'b', 'repo/other-tree', 'Continue the release cards spacing', NOW - 2 * DAY);
    addSession(db, 3, 'c', 'elsewhere', 'Write the pricing page', NOW - 3 * DAY);
    addSession(db, 4, 'd', 'repo', 'Ship the shipped thing again', NOW - 4 * DAY);
    addSession(db, 5, 'e', 'repo', 'Name this workspace', NOW - 4 * DAY);
    const dir = mkdtempSync(join(tmpdir(), 'request-first-'));
    mkdirSync(join(dir, 'progress'));
    writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: { [key('a')]: groupIdFor(key('a')), [key('d')]: groupIdFor(key('d')) }, groups: {
      [groupIdFor(key('a'))]: { title: 'Release cards', anchor: key('a'), projectRoot: 'repo', anchorAsk: { text: 'Build the release cards', atEpoch: NOW - 5 * DAY } },
      [groupIdFor(key('d'))]: { title: 'Shipped thing', anchor: key('d'), projectRoot: 'repo' },
    }, ignored: { [key('e')]: 'naming prompt' } }));
    writeFileSync(join(dir, 'progress', `${groupIdFor(key('d'))}.json`), JSON.stringify({ groupId: groupIdFor(key('d')), state: 'shipped', percent: 100 }));
    return { db, dir };
  }

  it('a grouping question holds only undecided conversations, one root at a time, beside that root\'s open requests', () => {
    const { db, dir } = ledgerFixture();
    try {
      const input = groupingInput(readLedger(dir), db, { sinceEpoch: NOW - 14 * DAY });
      // c (elsewhere) is the earliest undecided conversation, so its root goes first.
      expect(input.root).toBe('elsewhere');
      expect(input.conversations.map((conversation: any) => conversation.conversationKey)).toEqual([key('c')]);
      expect(input.openRequests).toEqual([]);
      expect(input.remaining).toBe(1);
      const next = applyGroupDecisions(readLedger(dir).groups, { groups: [{ title: 'Pricing page', conversations: [key('c')] }] }, NOW);
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify(next));
      const second = groupingInput(readLedger(dir), db, { sinceEpoch: NOW - 14 * DAY });
      expect(second.root).toBe('repo');
      expect(second.conversations.map((conversation: any) => [conversation.conversationKey, conversation.openingAsk])).toEqual([[key('b'), 'Continue the release cards spacing']]);
      // Shipped requests are not offered; decided and ignored conversations are never sent again.
      expect(second.openRequests.map((request: any) => [request.groupId, request.anchor, request.anchorAsk])).toEqual([[groupIdFor(key('a')), key('a'), 'Build the release cards']]);
      expect(() => validateGroupingAnswer({ groups: [{ title: 'Cards', conversations: [key('d'), key('b')] }] }, second)).toThrow(/not asked about/);
      expect(() => validateGroupingAnswer({ groups: [] }, second)).toThrow(/missing/);
      expect(() => validateGroupingAnswer({ groups: [{ title: 'Release cards', conversations: [key('a'), key('b')] }] }, second)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the refresh sends the agent only new conversations, batch by batch, and keeps earlier decisions', async () => {
    const { db, dir } = ledgerFixture();
    try {
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 2, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: join(import.meta.dir, '..', '..', 'plugin'), openDatabase: () => ({ prepare: db.prepare.bind(db), close() {} }), now: () => NOW, saveFocus: focusWriter(db).save });
      const sent: string[][] = [];
      const ask = async (question: string) => {
        if (question.includes('Do only section 1')) {
          const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(question)![1]);
          // The batch is inline and its keys are named; the saved copy matches.
          expect(JSON.parse(readFileSync(/also saved in (\S+\.json)/.exec(question)![1], 'utf8'))).toEqual(input);
          expect(question).toContain(`exactly once, in "groups" or "ignored": ${input.conversations.map((item: any) => item.conversationKey).join(', ')}.`);
          sent.push(input.conversations.map((conversation: any) => conversation.conversationKey));
          const [conversation] = input.conversations;
          return JSON.stringify(conversation.conversationKey === key('b')
            ? { groups: [{ title: 'Release cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }
            : { groups: [{ title: 'Pricing page', conversations: [conversation.conversationKey] }] });
        }
        if (question.includes('Do only section 2')) {
          const shows = JSON.parse(readFileSync(/is in (\S+\.json)/.exec(question)![1], 'utf8'));
          return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis })) });
        }
        if (question.includes('Do only section 3')) return everyRequestInOther(question);
        return JSON.stringify({ narrative: 'Under way.', preferences: [] });
      };
      expect(await task.run(ask as any, 'codex')).toMatch(/^2 new conversations grouped/);
      expect(sent).toEqual([[key('c')], [key('b')]]);
      const groups = readLedger(dir).groups;
      expect(groups.conversations[key('b')]).toBe(groupIdFor(key('a')));
      expect(groups.conversations[key('d')]).toBe(groupIdFor(key('d')));
      expect(groups.ignored[key('e')]).toBe('naming prompt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
};
const gitRepo = (dir: string) => { mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'init'); };

describe('the real project of an agent scratch-folder session', () => {
  it('is named the way claude-mem names the checkout, so git-remote naming does not split one repo in two', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-project-'));
    const previous = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    try {
      const repo = join(root, 'product');
      gitRepo(repo);
      git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/product.git');
      process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
      // A session started inside the checkout is stored as "acme/product"; one that only touched it must match.
      expect(projectFromToolPaths([JSON.stringify({ file_path: join(repo, 'README.md') })])).toBe('acme/product');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE; else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads native Windows paths and working folders on Windows', () => {
    const input = JSON.stringify({ file_path: 'C:\\work\\repo\\src\\app.ts', command: 'cd D:/code/site && npm test', cwd: 'C:\\work\\repo' });
    expect(pathsIn(input, 'win32')).toEqual(['C:\\work\\repo\\src\\app.ts', 'D:/code/site', 'C:\\work\\repo']);
    // Elsewhere a drive path is not a local path and is not looked up.
    expect(pathsIn(input, 'darwin')).toEqual([]);
  });


  it('comes from the repo its tool calls touched most, worktrees counted together, else the no-project pool', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-project-'));
    try {
      const repo = join(root, 'claude-mem'), tree = join(root, 'worktrees', 'claude-mem 🧠', 'cards'), other = join(root, 'other-repo');
      const scratch = join(root, 'Documents', 'Codex', '2026-10-13', 'det');
      for (const dir of [join(repo, 'src'), other, join(scratch, 'outputs')]) mkdirSync(dir, { recursive: true });
      gitRepo(repo); gitRepo(other);
      git(repo, 'worktree', 'add', '-q', tree);
      expect(pathsIn(JSON.stringify({ command: `rtk git -C '${tree}' status && ls ~15k ./relative` }))).toEqual([tree]);
      const calls = [
        JSON.stringify({ file_path: join(repo, 'src', 'a.ts') }),
        JSON.stringify({ command: `cd "${tree}" && git status` }),
        JSON.stringify({ command: `cat ${join(tree, 'missing-file.ts')} -n` }),
        JSON.stringify({ file_path: join(other, 'README.md') }),
        JSON.stringify({ path: join(scratch, 'outputs', 'plan.md') }),
      ];
      // Two checkouts of claude-mem outweigh one call into other-repo; the worktree was touched most.
      expect(projectFromToolPaths(calls)).toBe('claude-mem/cards');
      expect(projectFromToolPaths([calls[4]])).toBe(NO_PROJECT);

      const db = database();
      addSession(db, 1, 'det', 'det', 'Compare the memory moat', NOW, scratch);
      addSession(db, 2, 'wha', 'wha', 'Write the comparison', NOW, scratch);
      addSession(db, 3, 'det-no-folder', 'det', 'Explain the moat', NOW, null);
      addSession(db, 4, 'real', 'other-repo', 'Fix the readme', NOW, other);
      const call = db.prepare('INSERT INTO tool_uses (session_db_id, tool_name, tool_input, cwd, created_at_epoch) VALUES (?, ?, ?, ?, ?)');
      for (const input of calls) call.run(1, 'Bash', input, scratch, NOW);
      call.run(2, 'Read', calls[4], scratch, NOW);
      const sessions = db.prepare('SELECT id, project FROM sdk_sessions ORDER BY id').all() as any[];
      expect(withDerivedProjects(db, sessions).map((entry: any) => [entry.project, entry.storedProject])).toEqual([
        ['claude-mem/cards', 'det'], [NO_PROJECT, 'wha'], [NO_PROJECT, 'det'], ['other-repo', undefined],
      ]);
      // Grouping sees the derived project, so the session joins claude-mem's pool.
      expect(readCandidates(db, { sinceEpoch: 0 }).map((candidate: any) => candidate.project)).toEqual(['claude-mem/cards', NO_PROJECT, NO_PROJECT, 'other-repo']);
      // Stored rows are unchanged.
      expect((db.prepare('SELECT project FROM sdk_sessions WHERE id = 1').get() as any).project).toBe('det');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('projectRoot', () => {
  it('joins worktrees under their repo, but keeps git-remote org/repo keys apart', () => {
    expect(projectRoot('repo/feature-worktree', false)).toBe('repo');
    expect(projectRoot('acme/frontend', true)).toBe('acme/frontend');
    expect(projectRoot('acme/backend', true)).not.toBe(projectRoot('acme/frontend', true));
    expect(projectRoot(null, true)).toBeNull();
  });

  it('reads a root saved before git-remote keys were kept whole as its members\' full key', () => {
    expect(upgradedGroupRoot('acme', 'acme/frontend')).toBe('acme/frontend');
    expect(upgradedGroupRoot('acme', null, ['acme/backend', null])).toBe('acme/backend');
    // Members in two repositories leave it as saved: nothing joins them.
    expect(upgradedGroupRoot('acme', null, ['acme/backend', 'acme/frontend'])).toBe('acme');
    expect(upgradedGroupRoot('repo', 'repo')).toBe('repo');
    expect(upgradedGroupRoot('acme/frontend', 'acme/frontend')).toBe('acme/frontend');
    expect(upgradedGroupRoot(NO_PROJECT, 'acme/frontend')).toBe(NO_PROJECT);

    const previous = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    try {
      const groupId = groupIdFor(key('a'));
      const legacy = { conversations: { [key('a')]: groupId }, groups: { [groupId]: { title: 'Cards', anchor: key('a'), projectRoot: 'acme' } }, ignored: {} };
      const reapplied = applyGroupDecisions(legacy, { groups: [{ title: 'Cards', conversations: [key('a')] }] }, NOW, { projectOf: new Map([[key('a'), 'acme/frontend']]) });
      expect(reapplied.groups[groupId].projectRoot).toBe('acme/frontend');
      // Another repository of the same owner still cannot join it.
      expect(() => applyGroupDecisions(reapplied, { groups: [{ title: 'Cards', conversations: [key('a'), key('b')], links: link([key('a'), key('b')]) }] }, NOW, { projectOf: new Map([[key('a'), 'acme/frontend'], [key('b'), 'acme/backend']]) })).toThrow(/different projects/);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE; else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = previous;
    }
  });
});

import { describe, expect, it } from 'bun:test';
import { everyRequestInOther, focusWriter } from '../helpers/fake-focus-writer.js';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideSuggestion, jevClient, jevClientFromSettings, jevJudge, JOIN_THRESHOLD, judgeConversation, MAX_CANDIDATE_REQUESTS, MAX_DECISION_BODY_BYTES,
  OPENROUTER_DECISIONS_URL, routeUndecided, rulesJudge, SUGGEST_THRESHOLD,
} from '../../src/services/work-view/request-judge.mjs';
import { groupIdFor, groupingInput, openSuggestions, readLedger, runCli } from '../../src/services/work-view/request-groups.mjs';
import { buildRefreshTask } from '../../src/services/work-view/refresh-task.js';

const DAY = 86400000, NOW = 100 * DAY;
const key = (session: string, platform = 'claude') => JSON.stringify(['conversation', platform, session]);
const ledgerDir = () => mkdtempSync(join(tmpdir(), 'request-judge-test-'));
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');
const iso = (epoch: number) => new Date(epoch).toISOString();

/** a: the anchor of the open request "Release cards"; b and c: new in the same root; d: new in another root. */
function fixtureDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  const session = db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
  const prompt = db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)');
  session.run(1, 'claude', 'a', 'm1', 'repo', 'Build the release cards', NOW - 5 * DAY);
  prompt.run(1, 1, 'Build the release cards', NOW - 5 * DAY);
  prompt.run(1, 2, 'Add the ship date to each card', NOW - 5 * DAY + 1000);
  db.prepare('INSERT INTO observations (memory_session_id, type, title, created_at_epoch) VALUES (?, ?, ?, ?)').run('m1', 'feature', 'Card grid built', NOW - 5 * DAY + 2000);
  session.run(2, 'claude', 'b', 'm2', 'repo', 'Continue the release cards: fix the spacing', NOW - 2 * DAY);
  prompt.run(2, 1, 'Continue the release cards: fix the spacing', NOW - 2 * DAY);
  session.run(3, 'claude', 'c', 'm3', 'repo', 'Write the pricing page', NOW - DAY);
  prompt.run(3, 1, 'Write the pricing page', NOW - DAY);
  session.run(4, 'claude', 'd', 'm4', 'blog', 'Set up the blog', NOW - DAY + 1000);
  prompt.run(4, 1, 'Set up the blog', NOW - DAY + 1000);
  return db;
}

/** The ledger as a refresh left it: one open request anchored on a, nothing else decided. */
function ledgerWithOpenRequest(dir: string) {
  const groupId = groupIdFor(key('a'));
  writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, updatedAt: null, conversations: { [key('a')]: groupId }, groups: { [groupId]: { title: 'Release cards', anchor: key('a'), projectRoot: 'repo', links: [], decidedAt: null, anchorAsk: null } }, ignored: {} }));
  return groupId;
}

type Call = { state: any; questions: any };
/** A Jev stand-in: records every question and answers from the script. No network. */
function fakeJev(script: (state: any, questions: any) => any) {
  const calls: Call[] = [];
  const client = { name: 'jev' as const, url: 'https://cmem.ai/api/inference/v1/decisions', model: 'typesafe/jev-1.14', async decide(state: any, questions: any) { calls.push({ state, questions }); return script(state, questions); } };
  return { calls, client };
}
const choice = (picked: string, p: number, others: string[]) => ({ answers: { pick: { type: 'choice', choice: picked, probabilities: { [picked]: p, ...Object.fromEntries(others.map(other => [other, (1 - p) / others.length])) }, confidence: p } }, model: 'typesafe/jev-1.14-test' });
const noul = (score: number) => ({ answers: { same: { type: 'noul', noul: score } }, model: 'typesafe/jev-1.14-test' });
/** A judge stand-in for the refresh and CLI tests: joins the newest open request, else starts a request. */
const alwaysPlaces = { name: 'jev', judge: async (_conversation: unknown, openRequests: Array<{ groupId: string }>) => openRequests.length ? { requestId: openRequests[0].groupId, confidence: 0.9, evidence: 'stub scored 0.90' } : { requestId: null, confidence: 1, evidence: 'stub: no open request' } };
const handle = (database: Database) => () => ({ prepare: database.prepare.bind(database), close() {} });

describe('the request judge', () => {
  const conversation = { conversationKey: key('b'), context: { worktree: 'repo', started: '2026-10-24T10:00', asks: ['Continue the release cards: fix the spacing'], agent_recorded: [] } };
  const cards = { groupId: 'g_000000000001', title: 'Release cards', anchor: key('a'), context: { title: 'Release cards', worktree: 'repo', started: '2026-10-21T10:00', asks: ['Build the release cards'], agent_recorded: ['Card grid built'] } };
  const pricing = { groupId: 'g_000000000002', title: 'Pricing page', anchor: key('p'), context: { title: 'Pricing page', worktree: 'repo', started: '2026-10-22T10:00', asks: ['Write the pricing page'], agent_recorded: [] } };

  it('Jev gets one choice over the open requests plus none, then the calibrated check on the pick, and the check score is banded', async () => {
    const { calls, client } = fakeJev((_state, questions) => questions.pick ? choice(cards.groupId, 0.7, [pricing.groupId, 'none']) : noul(0.86));
    const verdict = await judgeConversation(conversation, [cards, pricing], jevJudge(client));
    expect(verdict).toEqual({ requestId: cards.groupId, confidence: 0.86, judge: 'jev', band: 'join', evidence: 'Judge jev (typesafe/jev-1.14-test): picked "Release cards" over 2 open requests (p 0.70); the check "continues that request" scored 0.86.' });
    expect(calls).toHaveLength(2);
    expect(calls[0].state).toEqual({ conversation: conversation.context, requests: { [cards.groupId]: cards.context, [pricing.groupId]: pricing.context } });
    expect(calls[0].questions.pick).toMatchObject({ type: 'choice', criteria: { [cards.groupId]: '`requests.g_000000000001`: Release cards', [pricing.groupId]: '`requests.g_000000000002`: Pricing page', none: 'None of these: a separate ask of its own' } });
    // The check is the measured question: the picked request and the conversation, Same work or Different work.
    expect(calls[1].state).toEqual({ request: cards.context, conversation: conversation.context });
    expect(calls[1].questions).toEqual({ same: { type: 'noul', instructions: expect.stringContaining('A person tracking their requests would want both on one card.'), criteria: { true: 'Same work', false: 'Different work' } } });

    // The bands, at the measured thresholds.
    expect([JOIN_THRESHOLD, SUGGEST_THRESHOLD]).toEqual([0.8, 0.5]);
    const banded = async (score: number) => judgeConversation(conversation, [cards, pricing], jevJudge(fakeJev((_state, questions) => questions.pick ? choice(cards.groupId, 0.7, ['none']) : noul(score)).client));
    expect(await banded(0.8)).toMatchObject({ band: 'join', requestId: cards.groupId });
    expect(await banded(0.79)).toMatchObject({ band: 'suggest', requestId: cards.groupId, confidence: 0.79 });
    expect(await banded(0.5)).toMatchObject({ band: 'suggest' });
    expect(await banded(0.49)).toEqual({ band: 'new', requestId: null, rejected: cards.groupId, confidence: 0.49, judge: 'jev', evidence: expect.stringContaining('scored 0.49') });
    // "none" needs no check.
    const none = fakeJev(() => choice('none', 0.9, [cards.groupId]));
    expect(await judgeConversation(conversation, [cards], jevJudge(none.client))).toEqual({ band: 'new', requestId: null, confidence: 0.9, judge: 'jev', evidence: 'Judge jev (typesafe/jev-1.14-test): none of 1 open request is continued (p 0.90).' });
    expect(none.calls).toHaveLength(1);
    // No open request in the root: a new request, no question asked.
    const quiet = fakeJev(() => { throw new Error('must not be asked'); });
    expect(await judgeConversation(conversation, [], jevJudge(quiet.client))).toMatchObject({ band: 'new', requestId: null, judge: 'jev' });
    // More open requests than one question takes: the newest MAX_CANDIDATE_REQUESTS go, and the evidence says so.
    const many = Array.from({ length: 25 }, (_, index) => ({ ...cards, groupId: `g_${String(index).padStart(12, '0')}`, title: `Request ${index}` }));
    const capped = fakeJev((_state, questions) => questions.pick ? choice(many[3].groupId, 0.6, ['none']) : noul(0.9));
    const verdictOfMany = await judgeConversation(conversation, many, jevJudge(capped.client));
    expect(Object.keys(capped.calls[0].state.requests)).toHaveLength(MAX_CANDIDATE_REQUESTS);
    expect(Object.keys(capped.calls[0].questions.pick.criteria)).toHaveLength(MAX_CANDIDATE_REQUESTS + 1);
    expect(verdictOfMany?.evidence).toContain('over the 19 most recently active of 25 open requests');
  });

  it('routing writes a join with the judge\'s evidence and the request\'s root, keeps a mid-band pick as a suggestion, and starts the rest', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      const checks: Record<string, number> = { 'Continue the release cards: fix the spacing': 0.9, 'Write the pricing page': 0.6 };
      const { calls, client } = fakeJev((state, questions) => questions.pick ? choice(groupId, 0.7, ['none']) : noul(checks[state.conversation.asks[0]]));
      const plan = await routeUndecided({ dir, database, judge: jevJudge(client), now: NOW, days: 14, apply: true });
      expect(plan).toMatchObject({ applied: true, judges: ['rules', 'jev'], counts: { joined: 1, suggested: 1, new: 1, unplaced: 0 } });
      const ledger = readLedger(dir);
      // b joined: the link names the judge and its score, and the request records its root.
      expect(ledger.groups.conversations[key('b')]).toBe(groupId);
      expect(ledger.groups.groups[groupId]).toMatchObject({ title: 'Release cards', projectRoot: 'repo', links: [{ kind: 'judge', conversations: [key('a'), key('b')], evidence: 'Judge jev (typesafe/jev-1.14-test): picked "Release cards" over 1 open request (p 0.70); the check "continues that request" scored 0.90.' }] });
      expect(ledger.groups.groups[groupId].anchorAsk).toMatchObject({ text: 'Build the release cards' });
      // c is its own request, with the mid-band pick kept for the owner.
      expect(ledger.groups.conversations[key('c')]).toBe(groupIdFor(key('c')));
      expect(ledger.groups.groups[groupIdFor(key('c'))]).toMatchObject({ title: 'Write the pricing page', projectRoot: 'repo' });
      expect(ledger.groups.suggestions[key('c')]).toEqual({ requestId: groupId, confidence: 0.6, judge: 'jev', status: 'open', at: iso(NOW), evidence: expect.stringContaining('scored 0.60') });
      expect(openSuggestions(ledger)).toEqual([{ conversationKey: key('c'), requestId: groupId, requestTitle: 'Release cards', confidence: 0.6, judge: 'jev', at: iso(NOW), evidence: expect.stringContaining('scored 0.60') }]);
      // d: another root with no open request, its own request without a question.
      expect(ledger.groups.groups[groupIdFor(key('d'))]).toMatchObject({ title: 'Set up the blog', anchor: key('d') });
      expect(calls.filter(call => call.state.conversation.asks[0] === 'Set up the blog')).toHaveLength(0);
      // The questions carried the measured context: worktree, start, first prompts and recorded titles.
      expect(calls[0].state.conversation).toEqual({ worktree: 'repo', started: iso(NOW - 2 * DAY).slice(0, 16), asks: ['Continue the release cards: fix the spacing'], agent_recorded: [] });
      expect(calls[0].state.requests[groupId]).toEqual({ title: 'Release cards', worktree: 'repo', started: iso(NOW - 5 * DAY).slice(0, 16), asks: ['Build the release cards', 'Add the ship date to each card'], agent_recorded: ['Card grid built'] });
      // The pricing page was offered to the conversations after it: a request started here is open at once.
      expect(plan.routed.map(entry => [entry.conversationKey, entry.band, entry.requestId])).toEqual([[key('b'), 'join', groupId], [key('c'), 'suggest', groupIdFor(key('c'))], [key('d'), 'new', groupIdFor(key('d'))]]);
      expect(plan.routed[1]).toMatchObject({ suggestedRequestId: groupId, suggestedRequestTitle: 'Release cards' });
      // Nothing is left for the grouping agent.
      expect(groupingInput(ledger, database, { sinceEpoch: NOW - 14 * DAY }).conversations).toEqual([]);

      // The owner's answer: Join moves c in through the same decisions; a second answer finds nothing open.
      expect(decideSuggestion({ dir, database, conversationKey: key('c'), action: 'join', now: NOW + 1000 })).toEqual({ status: 'joined', requestId: groupId });
      const joined = readLedger(dir);
      expect(joined.groups.conversations[key('c')]).toBe(groupId);
      expect(joined.groups.groups[groupId].links[1]).toEqual({ kind: 'judge', conversations: [key('a'), key('c')], evidence: expect.stringMatching(/^Owner joined on the judge's suggestion\. Judge jev/) });
      expect(joined.groups.groups[groupIdFor(key('c'))]).toBeUndefined();
      expect(joined.groups.suggestions[key('c')]).toMatchObject({ status: 'joined', resolvedAt: iso(NOW + 1000) });
      expect(openSuggestions(joined)).toEqual([]);
      expect(decideSuggestion({ dir, database, conversationKey: key('c'), action: 'join' })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an owner answer saved while the judge is awaited survives the routing run', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      const { client } = fakeJev((state, questions) => {
        // The owner joins b on its suggestion while c's question is out.
        if (questions.pick && state.conversation.asks[0] === 'Write the pricing page') decideSuggestion({ dir, database, conversationKey: key('b'), action: 'join', now: NOW + 500 });
        return questions.pick ? choice(groupId, 0.7, ['none']) : noul(state.conversation.asks[0] === 'Write the pricing page' ? 0.2 : 0.6);
      });
      await routeUndecided({ dir, database, judge: jevJudge(client), now: NOW, apply: true });
      const ledger = readLedger(dir);
      expect(ledger.groups.conversations[key('b')]).toBe(groupId);
      expect(ledger.groups.suggestions[key('b')]).toMatchObject({ status: 'joined' });
      expect(ledger.groups.conversations[key('c')]).toBe(groupIdFor(key('c')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Join brings the members that joined the suggested conversation\'s own request, leaving no stale anchor', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = groupIdFor(key('a'));
      ledgerWithOpenRequest(dir);
      // b is a mid-band pick for the cards request, so it starts its own; c then joins b's request.
      const { client } = fakeJev((state, questions) => state.conversation.asks[0] === 'Write the pricing page'
        ? (questions.pick ? choice(groupIdFor(key('b')), 0.9, [groupId, 'none']) : noul(0.9))
        : (questions.pick ? choice(groupId, 0.7, ['none']) : noul(0.6)));
      await routeUndecided({ dir, database, judge: jevJudge(client), now: NOW, apply: true });
      expect(readLedger(dir).groups.conversations[key('c')]).toBe(groupIdFor(key('b')));
      expect(decideSuggestion({ dir, database, conversationKey: key('b'), action: 'join', now: NOW + 1000 })).toEqual({ status: 'joined', requestId: groupId });
      const joined = readLedger(dir).groups;
      expect(joined.conversations[key('b')]).toBe(groupId);
      expect(joined.conversations[key('c')]).toBe(groupId);
      expect(joined.groups[groupIdFor(key('b'))]).toBeUndefined();
      expect(joined.groups[groupId].links.map((link: any) => link.conversations)).toEqual([[key('a'), key('b')], [key('b'), key('c')]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a join picked against a request the owner merged meanwhile goes to the request that holds it now', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      const bId = groupIdFor(key('b'));
      // b is a mid-band pick for the cards; c is picked for b's request, and the owner joins b while c is asked.
      const { client } = fakeJev((state, questions) => {
        if (state.conversation.asks[0] !== 'Write the pricing page') return questions.pick ? choice(groupId, 0.7, ['none']) : noul(0.6);
        if (questions.pick) { decideSuggestion({ dir, database, conversationKey: key('b'), action: 'join', now: NOW + 500 }); return choice(bId, 0.9, [groupId, 'none']); }
        return noul(0.9);
      });
      await routeUndecided({ dir, database, judge: jevJudge(client), now: NOW, apply: true });
      const ledger = readLedger(dir).groups;
      expect(ledger.conversations[key('b')]).toBe(groupId);
      expect(ledger.conversations[key('c')]).toBe(groupId);
      expect(ledger.groups[bId]).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a Join that absorbs a request points the suggestions aimed at it at the request that absorbed it', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      const bId = groupIdFor(key('b'));
      const { client } = fakeJev((state, questions) => state.conversation.asks[0] === 'Write the pricing page'
        ? (questions.pick ? choice(bId, 0.7, [groupId, 'none']) : noul(0.6))
        : (questions.pick ? choice(groupId, 0.7, ['none']) : noul(0.6)));
      await routeUndecided({ dir, database, judge: jevJudge(client), now: NOW, apply: true });
      expect(readLedger(dir).groups.suggestions[key('c')]).toMatchObject({ requestId: bId, status: 'open' });
      decideSuggestion({ dir, database, conversationKey: key('b'), action: 'join', now: NOW + 1000 });
      const ledger = readLedger(dir);
      expect(ledger.groups.suggestions[key('c')]).toMatchObject({ requestId: groupId, status: 'open' });
      expect(openSuggestions(ledger).map(entry => [entry.conversationKey, entry.requestId])).toEqual([[key('c'), groupId]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Not this keeps the conversation as its own request and records that the owner declined', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      const { client } = fakeJev((_state, questions) => questions.pick ? choice(groupId, 0.6, ['none']) : noul(0.6));
      await routeUndecided({ dir, database, judge: jevJudge(client), now: NOW, apply: true });
      expect(openSuggestions(readLedger(dir)).map(entry => entry.conversationKey)).toEqual([key('b'), key('c')]);
      expect(decideSuggestion({ dir, database, conversationKey: key('b'), action: 'not-this', now: NOW + 1000 })).toEqual({ status: 'declined', requestId: groupIdFor(key('b')) });
      const ledger = readLedger(dir);
      expect(ledger.groups.conversations[key('b')]).toBe(groupIdFor(key('b')));
      expect(ledger.groups.groups[groupIdFor(key('b'))].title).toBe('Continue the release cards: fix the spacing');
      expect(ledger.groups.suggestions[key('b')]).toMatchObject({ status: 'declined', resolvedAt: iso(NOW + 1000), evidence: expect.stringMatching(/^Owner declined: not part of "Release cards"\. Judge jev/) });
      expect(openSuggestions(ledger).map(entry => entry.conversationKey)).toEqual([key('c')]);
      expect(() => decideSuggestion({ dir, database, conversationKey: key('c'), action: 'merge' as any })).toThrow(/join or not-this/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('without a Jev judge, a code link joins and everything else waits for the grouping agent', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const write = database.prepare('INSERT INTO tool_uses (session_db_id, tool_name, tool_input, created_at_epoch) VALUES (?, ?, ?, ?)');
      write.run(1, 'mcp__work_state_write', JSON.stringify({ list: 'release-cards', fields: { task: 'cards' } }), NOW - 5 * DAY);
      write.run(2, 'mcp__work_state_write', JSON.stringify({ list: 'release-cards', fields: { task: 'spacing' } }), NOW - 2 * DAY);
      const groupId = ledgerWithOpenRequest(dir);
      const plan = await routeUndecided({ dir, database, judge: null, now: NOW, apply: true });
      expect(plan).toMatchObject({ judges: ['rules'], counts: { joined: 1, suggested: 0, new: 0, unplaced: 2 } });
      expect(plan.routed[0]).toMatchObject({ conversationKey: key('b'), band: 'join', judge: 'rules', confidence: 1, requestId: groupId, evidence: 'Judge rules: shared-work-list work list "release-cards" in repo' });
      expect(plan.unplaced.map(entry => [entry.conversationKey, entry.reason])).toEqual([[key('c'), 'no code link, and no Jev judge is configured: the grouping agent decides'], [key('d'), 'no code link, and no Jev judge is configured: the grouping agent decides']]);
      const ledger = readLedger(dir);
      expect(ledger.groups.groups[groupId].links).toEqual([{ kind: 'judge', conversations: [key('a'), key('b')], evidence: 'Judge rules: shared-work-list work list "release-cards" in repo' }]);
      expect(ledger.groups.conversations[key('c')]).toBeUndefined();
      // Exactly those reach the agent batch, unchanged.
      expect(groupingInput(ledger, database, { sinceEpoch: NOW - 14 * DAY }).conversations.map(entry => entry.conversationKey)).toEqual([key('c')]);
      // The rules judge on its own: one linked open request joins, none or several does not.
      expect(await rulesJudge.judge({ conversationKey: key('b'), context: conversation.context, links: [{ kind: 'shared-request-id', conversations: [key('a'), key('b')], evidence: 'request_id "r1"', groups: [cards.groupId] }] }, [cards])).toEqual({ requestId: cards.groupId, confidence: 1, evidence: 'Judge rules: shared-request-id request_id "r1"' });
      expect(await rulesJudge.judge({ conversationKey: key('b'), context: conversation.context, links: [{ kind: 'shared-work-list', conversations: [key('a'), key('b'), key('p')], evidence: 'work list "x" in repo', groups: [cards.groupId, pricing.groupId] }] }, [cards, pricing])).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a refused or failed Jev call leaves the conversation for the agent; the state is never trimmed', async () => {
    const dir = ledgerDir();
    try {
      let sent = 0;
      const big = jevClient({ url: 'https://cmem.ai/api/inference/v1/decisions', apiKey: `cm_pro_${'a'.repeat(24)}`, fetchImpl: async () => { sent++; return new Response('{"answers":{}}'); } });
      await expect(big.decide({ blob: 'x'.repeat(MAX_DECISION_BODY_BYTES) }, {})).rejects.toThrow(/takes at most 65536\. It is not trimmed/);
      expect(sent).toBe(0);
      const spent = jevClient({ url: 'https://cmem.ai/api/inference/v1/decisions', apiKey: `cm_pro_${'a'.repeat(24)}`, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'allowance_exhausted', message: 'Monthly allowance spent.', request_id: 'req_1' } }), { status: 402 }) });
      await expect(spent.decide({ a: 1 }, { q: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } })).rejects.toThrow('Jev answered 402 allowance_exhausted: Monthly allowance spent. (request req_1)');
      const database = fixtureDatabase();
      ledgerWithOpenRequest(dir);
      const plan = await routeUndecided({ dir, database, judge: jevJudge(spent), now: NOW, apply: true });
      // b and c had an open request to check and the call failed; d had none and needed no call.
      expect(plan.counts).toEqual({ joined: 0, suggested: 0, new: 1, unplaced: 2 });
      expect(plan.unplaced.map(entry => entry.conversationKey)).toEqual([key('b'), key('c')]);
      expect(plan.unplaced[0].reason).toBe('jev: Jev answered 402 allowance_exhausted: Monthly allowance spent. (request req_1)');
      const ledger = readLedger(dir);
      expect(ledger.groups.conversations[key('b')]).toBeUndefined();
      expect(ledger.groups.conversations[key('d')]).toBe(groupIdFor(key('d')));
      expect(groupingInput(ledger, database, { sinceEpoch: NOW - 14 * DAY }).conversations.map(entry => entry.conversationKey)).toEqual([key('b'), key('c')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a Jev client comes only from the CMEM Pro gateway or openrouter.ai, with the matching key', async () => {
    const none = () => undefined;
    let sent: { url: string; body: any; authorization: string | null } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)), authorization: (init.headers as Record<string, string>).Authorization ?? null };
      return new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 0.5 } }, model: 'typesafe/jev-1.14' }));
    }) as unknown as typeof fetch;
    const question = { q: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } };
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-1' }, { credential: none })).toBeNull();
    // CMEM Pro: the gateway's /decisions with the account key; the gateway pins the judge, so no model is sent.
    const pro = jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1', CLAUDE_MEM_OPENROUTER_API_KEY: `cm_pro_${'b'.repeat(24)}` }, { credential: none, fetchImpl });
    expect(pro?.url).toBe('https://cmem.ai/api/inference/v1/decisions');
    expect((await pro!.decide({ a: 1 }, question)).answers.q.noul).toBe(0.5);
    expect(sent).toEqual({ url: 'https://cmem.ai/api/inference/v1/decisions', body: { state: { a: 1 }, questions: question }, authorization: `Bearer cm_pro_${'b'.repeat(24)}` });
    // Bring your own key: OpenRouter's Decisions API, naming the measured release.
    const own = jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: '', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-1' }, { credential: none, fetchImpl });
    expect(own?.url).toBe(OPENROUTER_DECISIONS_URL);
    await own!.decide({ a: 2 }, question);
    expect(sent).toEqual({ url: OPENROUTER_DECISIONS_URL, body: { model: 'typesafe/jev-1.14', state: { a: 2 }, questions: question }, authorization: 'Bearer sk-or-1' });
    // The key may come from ~/.claude-mem/.env, as the observer's does.
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter' }, { credential: name => name === 'OPENROUTER_API_KEY' ? 'sk-or-env' : undefined })?.url).toBe(OPENROUTER_DECISIONS_URL);
    // Another OpenAI-compatible endpoint has no Decisions API; keys and endpoints never cross; no key, no judge.
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://api.deepseek.com', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-1' }, { credential: none })).toBeNull();
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-1' }, { credential: none })).toBeNull();
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: '', CLAUDE_MEM_OPENROUTER_API_KEY: `cm_pro_${'b'.repeat(24)}` }, { credential: none })).toBeNull();
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter' }, { credential: none })).toBeNull();
    // A pool-only install (no primary key) uses the first pool key off the gateway; never on it.
    expect((jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEYS: 'sk-or-pool-1, sk-or-pool-2' }, { credential: none, fetchImpl: undefined }) as any)?.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(jevClientFromSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1', CLAUDE_MEM_OPENROUTER_API_KEYS: 'sk-or-pool-1' }, { credential: none })).toBeNull();
  });

  it('the refresh runs the judge before any agent batch: a placed conversation never reaches the grouping prompt', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 3, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), judge: alwaysPlaces, now: () => NOW, saveFocus: focusWriter(database).save });
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 1')) throw new Error('the judge placed every conversation; no grouping batch may be asked');
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('Do only section 2')) {
          const shows = JSON.parse((await import('node:fs')).readFileSync(/is in (\S+\.json)/.exec(prompt)![1], 'utf8'));
          return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 30, summary: 'Under way.', reviewBasis: show.reviewBasis })) });
        }
        return JSON.stringify({ narrative: 'Two requests under way.', preferences: [] });
      };
      expect(await task.run(ask, 'codex')).toBe('3 new conversations judged (2 joined, 0 suggested, 1 new), 2 requests reviewed, 2 requests placed, story written.');
      expect(task.steps[0]).toMatchObject({ step: 'judge', agent: 'codex', groups: 3 });
      const ledger = readLedger(dir);
      expect(ledger.groups.conversations).toEqual({ [key('a')]: groupId, [key('b')]: groupId, [key('c')]: groupId, [key('d')]: groupIdFor(key('d')) });
      expect(ledger.groups.groups[groupId].links.map((link: any) => link.evidence)).toEqual(['stub scored 0.90', 'stub scored 0.90']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('`judge --days N` prints the plan and writes only with --apply', async () => {
    const dir = ledgerDir();
    try {
      const database = fixtureDatabase();
      const groupId = ledgerWithOpenRequest(dir);
      let output: any;
      const print = (value: unknown) => { output = value; };
      await runCli(['judge', '--days', '14'], { dir, database, now: NOW, print, judge: alwaysPlaces });
      expect(output).toMatchObject({ days: 14, applied: false, judges: ['rules', 'jev'], counts: { joined: 2, suggested: 0, new: 1, unplaced: 0 } });
      expect(output.routed.map((entry: any) => [entry.conversationKey, entry.band, entry.requestId, entry.requestTitle])).toEqual([[key('b'), 'join', groupId, 'Release cards'], [key('c'), 'join', groupId, 'Release cards'], [key('d'), 'new', groupIdFor(key('d')), 'Set up the blog']]);
      expect(readLedger(dir).groups.conversations).toEqual({ [key('a')]: groupId });
      await runCli(['judge', '--days', '14', '--apply'], { dir, database, now: NOW, print, judge: alwaysPlaces });
      expect(output.applied).toBe(true);
      expect(readLedger(dir).groups.conversations[key('b')]).toBe(groupId);
      // A second run finds nothing left to route.
      await runCli(['judge', '--days', '14', '--apply'], { dir, database, now: NOW, print, judge: alwaysPlaces });
      expect(output).toMatchObject({ routed: [], unplaced: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

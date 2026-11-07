import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askFocusArea, FOCUS_AUTO_PLACE_THRESHOLD, jevFocusJudge, judgeFocusBatch, MIN_OWNER_LABELED_PAIRS, placesAlone } from '../../src/services/work-view/focus-judge.mjs';
import { focusAreaRowFields, MY_FOCUS_LIST, readFocus } from '../../src/services/work-view/my-focus.mjs';
import { groupIdFor, readLedger, runCli } from '../../src/services/work-view/request-groups.mjs';
import { jevClient, MAX_CANDIDATE_REQUESTS, MAX_DECISION_BODY_BYTES } from '../../src/services/work-view/request-judge.mjs';
import { buildRefreshTask } from '../../src/services/work-view/refresh-task.js';
import { everyRequestInOther, focusInputFrom, focusWriter, isOtherPass } from '../helpers/fake-focus-writer.js';

const DAY = 86400000, NOW = 100 * DAY;
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const ledgerDir = () => mkdtempSync(join(tmpdir(), 'focus-judge-test-'));
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');
const handle = (database: Database) => () => ({ prepare: database.prepare.bind(database), close() {} });

/** Three requests (cards, pricing, blog), each one conversation; two kept areas and one suggested. */
function fixture(dir: string, { cardsTitle = 'Release cards' } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  const session = db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
  const prompt = db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)');
  const requests = [['a', 'Build the release cards', cardsTitle], ['c', 'Write the pricing page', 'Pricing page'], ['d', 'Set up the blog', 'Blog setup']] as const;
  requests.forEach(([id, ask], index) => { session.run(index + 1, 'claude', id, `m${id}`, 'repo', ask, NOW - (3 - index) * DAY); prompt.run(index + 1, 1, ask, NOW - (3 - index) * DAY); });
  const area = db.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
  const areas = [['fa_cards', 'Release cards', 'kept'], ['fa_pricing', 'Pricing', 'kept'], ['fa_writing', 'Writing', 'suggested']] as const;
  areas.forEach(([focusAreaId, name, status], index) => area.run('home', MY_FOCUS_LIST, JSON.stringify(focusAreaRowFields({ focusAreaId, name, goal: `Ship ${name}.`, about: `${name} work.`, status, source: 'seed', decidedBy: 'owner' })), 10 + index));
  writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({
    version: 1, updatedAt: null, ignored: {},
    conversations: Object.fromEntries(requests.map(([id]) => [key(id), groupIdFor(key(id))])),
    groups: Object.fromEntries(requests.map(([id, , title]) => [groupIdFor(key(id)), { title, anchor: key(id), projectRoot: 'repo', links: [], decidedAt: null, anchorAsk: null }])),
  }));
  return db;
}

type Call = { state: any; questions: any };
/** A Jev stand-in that records every question and answers from the script. No network. */
function fakeJev(script: (state: any, questions: any, call: number) => any) {
  const calls: Call[] = [];
  const client = { name: 'jev' as const, url: 'https://cmem.ai/api/inference/v1/decisions', model: 'typesafe/jev-1.14', async decide(state: any, questions: any) { calls.push({ state, questions }); return script(state, questions, calls.length); } };
  return { calls, client };
}
const choice = (picked: string, p: number) => ({ answers: { area: { type: 'choice', choice: picked, probabilities: { [picked]: p }, confidence: p } }, model: 'typesafe/jev-1.14-test' });
const areaList = (count: number) => Array.from({ length: count }, (_, index) => ({ focusAreaId: `fa_${String(index).padStart(2, '0')}`, name: `Area ${index}`, goal: null, about: null }));
const request = { title: 'Release cards', worktree: 'repo', started: null, asks: ['Build the release cards'], agent_recorded: [] };

describe('the focus judge', () => {
  it('asks one choice over the kept areas plus none, in plain words, and reads the pick', async () => {
    const { calls, client } = fakeJev(() => choice('fa_cards', 0.83));
    const areas = [{ focusAreaId: 'fa_cards', name: 'Release cards', goal: 'Ship cards.', about: 'Cards.' }, { focusAreaId: 'fa_pricing', name: 'Pricing', goal: null, about: null }];
    expect(await askFocusArea(client, request, areas)).toEqual({ focusAreaId: 'fa_cards', confidence: 0.83, evidence: 'Judge jev (typesafe/jev-1.14-test): "Release cards" over 2 kept focus areas (p 0.83).' });
    expect(calls).toEqual([{
      state: { request, areas: { fa_cards: { name: 'Release cards', goal: 'Ship cards.', about: 'Cards.' }, fa_pricing: { name: 'Pricing', goal: null, about: null } } },
      questions: { area: { type: 'choice', instructions: expect.stringContaining('Pick `none` if it fits none of these areas.'), criteria: { fa_cards: '`areas.fa_cards`: Release cards', fa_pricing: '`areas.fa_pricing`: Pricing', none: 'None of these focus areas' } } },
    }]);
    // none is Other; a pick that was not offered is an error, never a guess.
    expect(await askFocusArea(fakeJev(() => choice('none', 0.7)).client, request, areas)).toMatchObject({ focusAreaId: 'other', confidence: 0.7, evidence: expect.stringContaining('none of 2 kept focus areas fits (p 0.70)') });
    await expect(askFocusArea(fakeJev(() => choice('fa_gone', 0.9)).client, request, areas)).rejects.toThrow('Jev picked "fa_gone", which was not offered.');
  });

  it('asks more than 19 kept areas in sets, then once more over the set winners, and says so', async () => {
    const areas = areaList(25);
    // Both sets pick an area: a third question over just the two winners.
    const both = fakeJev((state, _questions, call) => call === 1 ? choice('fa_03', 0.6) : call === 2 ? choice('fa_21', 0.7) : choice('fa_21', 0.8));
    expect(await askFocusArea(both.client, request, areas)).toEqual({ focusAreaId: 'fa_21', confidence: 0.8, evidence: 'Judge jev (typesafe/jev-1.14-test): "Area 21" over 25 kept focus areas, asked in 2 sets of up to 19 and 1 final question over the set winners (p 0.80).' });
    expect(both.calls.map(call => Object.keys(call.state.areas).length)).toEqual([MAX_CANDIDATE_REQUESTS, 6, 2]);
    expect(Object.keys(both.calls[2].questions.area.criteria)).toEqual(['fa_03', 'fa_21', 'none']);
    // One set picks: no final question.
    const one = fakeJev((_state, _questions, call) => call === 1 ? choice('none', 0.9) : choice('fa_20', 0.65));
    expect(await askFocusArea(one.client, request, areas)).toMatchObject({ focusAreaId: 'fa_20', confidence: 0.65, evidence: expect.stringContaining('asked in 2 sets of up to 19 (p 0.65)') });
    expect(one.calls).toHaveLength(2);
    // No set picks: Other, at the least sure set's none.
    const none = fakeJev((_state, _questions, call) => choice('none', call === 1 ? 0.9 : 0.55));
    expect(await askFocusArea(none.client, request, areas)).toMatchObject({ focusAreaId: 'other', confidence: 0.55 });
  });

  it('a body over 64 KB is refused before it is sent and never trimmed; a failed call leaves the request unjudged', async () => {
    const dir = ledgerDir();
    try {
      let sent = 0;
      const big = jevClient({ url: 'https://cmem.ai/api/inference/v1/decisions', apiKey: `cm_pro_${'a'.repeat(24)}`, fetchImpl: async () => { sent++; return new Response('{"answers":{}}'); } });
      // The request's title is not cut by the context reader, so a huge one makes the question too large.
      const database = fixture(dir, { cardsTitle: 'x'.repeat(MAX_DECISION_BODY_BYTES) });
      const ledger = readLedger(dir);
      const input = { ...runFocusInput(dir, database) };
      const results = await judgeFocusBatch({ judge: jevFocusJudge(big), input, database: handle(database)(), ledger });
      const cards = results.find(result => result.anchor === key('a'))!;
      expect(cards).toEqual({ anchor: key('a'), focusAreaId: null, confidence: null, evidence: expect.stringContaining('the decisions gateway takes at most 65536. It is not trimmed') });
      // The other two were small enough and were sent, once each, with no retry.
      expect(sent).toBe(2);

      const spent = jevClient({ url: 'https://cmem.ai/api/inference/v1/decisions', apiKey: `cm_pro_${'a'.repeat(24)}`, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'allowance_exhausted', message: 'Monthly allowance spent.' } }), { status: 402 }) });
      expect((await judgeFocusBatch({ judge: jevFocusJudge(spent), input, database: handle(database)(), ledger }))[1]).toEqual({ anchor: key('c'), focusAreaId: null, confidence: null, evidence: 'Judge jev could not judge it: Jev answered 402 allowance_exhausted: Monthly allowance spent.' });
      // Only kept areas are offered; with none kept, nothing is asked.
      const quiet = fakeJev(() => { throw new Error('must not be asked'); });
      expect((await judgeFocusBatch({ judge: jevFocusJudge(quiet.client), input: { ...input, areas: input.areas.filter((area: any) => area.status !== 'kept') }, database: handle(database)(), ledger }))[0]).toMatchObject({ focusAreaId: null, evidence: 'Judge jev: no kept focus area to choose from.' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('places alone only a kept-area pick at or above a set threshold; the shipped threshold is null', () => {
    expect(FOCUS_AUTO_PLACE_THRESHOLD).toBeNull();
    expect(MIN_OWNER_LABELED_PAIRS).toBe(97);
    expect(placesAlone({ focusAreaId: 'fa_cards', confidence: 0.99 })).toBe(false);
    expect(placesAlone({ focusAreaId: 'fa_cards', confidence: 0.79 }, 0.8)).toBe(false);
    expect(placesAlone({ focusAreaId: 'fa_cards', confidence: 0.8 }, 0.8)).toBe(true);
    expect(placesAlone({ focusAreaId: 'other', confidence: 0.99 }, 0.8)).toBe(false);
    expect(placesAlone({ focusAreaId: null, confidence: null }, 0.8)).toBe(false);
    expect(() => placesAlone({ focusAreaId: 'fa_cards', confidence: 0.9 }, Number.NaN)).toThrow(TypeError);
  });
});

/** The saves that placed requests (the Other pass saves only its hash). */
const placing = <T extends { placements: unknown[] }>(bodies: T[]) => bodies.filter(body => body.placements.length);

function runFocusInput(dir: string, database: Database) {
  let output: any;
  runCli(['focus-input'], { dir, database: handle(database)(), now: NOW, print: value => { output = value; }, localDeviceId: '' });
  return output;
}

/** A refresh with nothing to group: reviews, places (every request in Other unless told otherwise) and writes the story. */
function refresh(dir: string, database: Database, options: Record<string, unknown>) {
  const writer = focusWriter(database);
  const focusPrompts: any[] = [];
  const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 3, ungrouped: 0, goalsStale: false, unplaced: 3, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save, ...options });
  const ask = async (prompt: string) => {
    if (prompt.includes('Do only section 3')) {
      if (!isOtherPass(prompt)) focusPrompts.push({ input: focusInputFrom(prompt), current: runFocusInput(dir, database) });
      return everyRequestInOther(prompt);
    }
    if (prompt.includes('Do only section 2')) {
      const shows = JSON.parse(readFileSync(/is in (\S+\.json)/.exec(prompt)![1], 'utf8'));
      return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 30, summary: 'Under way.', reviewBasis: show.reviewBasis })) });
    }
    return JSON.stringify({ narrative: 'Three requests under way.', preferences: [] });
  };
  return { task, writer, focusPrompts, run: () => task.run(ask, 'codex') };
}

describe('the focus judge in the refresh', () => {
  it('without a focus judge the agent batch is exactly focus-input, unchanged', async () => {
    const dir = ledgerDir();
    try {
      const database = fixture(dir);
      const { task, writer, focusPrompts, run } = refresh(dir, database, {});
      expect(await run()).toBe('3 requests reviewed, 3 requests placed, story written.');
      expect(focusPrompts).toHaveLength(1);
      expect(focusPrompts[0].input).toEqual(focusPrompts[0].current);
      expect(focusPrompts[0].input.requests.some((entry: any) => 'judgeSuggestion' in entry)).toBe(false);
      expect(task.steps.map(entry => entry.step)).not.toContain('focus-judge');
      expect(placing(writer.bodies)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('with the shipped null threshold every pick is a hint on its request and the agent places all of them', async () => {
    const dir = ledgerDir();
    try {
      const database = fixture(dir);
      const { calls, client } = fakeJev(state => state.request.title === 'Release cards' ? choice('fa_cards', 0.97) : choice('none', 0.6));
      const { task, writer, focusPrompts, run } = refresh(dir, database, { focusJudge: jevFocusJudge(client) });
      expect(await run()).toBe('3 requests reviewed, 3 requests judged for focus (1 picked an area, 2 none, 0 unjudged), 3 requests placed, story written.');
      // Only the kept areas were offered; the suggested one is the agent's to consider.
      expect(Object.keys(calls[0].state.areas).sort()).toEqual(['fa_cards', 'fa_pricing']);
      expect(calls[0].state.request).toMatchObject({ title: 'Release cards', worktree: 'repo', asks: ['Build the release cards'] });
      const requests = focusPrompts[0].input.requests;
      expect(requests.map((entry: any) => entry.anchor)).toEqual([key('a'), key('c'), key('d')]);
      expect(requests[0].judgeSuggestion).toEqual({ focusAreaId: 'fa_cards', confidence: 0.97, evidence: 'Judge jev (typesafe/jev-1.14-test): "Release cards" over 2 kept focus areas (p 0.97).' });
      expect(requests[1].judgeSuggestion).toMatchObject({ focusAreaId: 'other', confidence: 0.6 });
      // Apart from the hints, the batch is focus-input as it stands.
      expect(requests.map(({ judgeSuggestion, ...rest }: any) => rest)).toEqual(focusPrompts[0].current.requests);
      // The agent decided: its answer put all three in Other, and nothing was written before it.
      expect(placing(writer.bodies)).toHaveLength(1);
      expect(placing(writer.bodies)[0].placements.map(placement => placement.focusAreaId)).toEqual(['other', 'other', 'other']);
      expect(task.steps.find(entry => entry.step === 'focus-judge')).toMatchObject({ agent: 'codex', groups: 3 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('with an injected threshold a pick at or above it is a router placement and leaves the batch; below it, or unjudged, goes to the agent', async () => {
    const dir = ledgerDir();
    try {
      const database = fixture(dir);
      const { calls, client } = fakeJev(state => {
        if (state.request.title === 'Release cards') return choice('fa_cards', 0.8);
        if (state.request.title === 'Pricing page') return choice('fa_pricing', 0.79);
        throw new Error('Jev answered 503: unavailable');
      });
      const { writer, focusPrompts, run } = refresh(dir, database, { focusJudge: jevFocusJudge(client), focusAutoPlaceThreshold: 0.8 });
      expect(await run()).toBe('3 requests reviewed, 3 requests judged for focus (2 picked an area, 0 none, 1 unjudged, 1 placed without the agent), 3 requests placed, story written.');
      // Each request was asked once, though the batch was read again after the placement.
      expect(calls).toHaveLength(3);
      // The judge's placement was written first, as the router, with its confidence and evidence.
      const evidence = 'Judge jev (typesafe/jev-1.14-test): "Release cards" over 2 kept focus areas (p 0.80).';
      expect(writer.bodies[0]).toEqual({ placements: [{ anchorConversationKey: key('a'), focusAreaId: 'fa_cards', basis: expect.any(String), confidence: 0.8, evidence }], proposals: [] });
      expect(readFocus(database, { localDeviceId: '' }).placementsByAnchor.get(key('a'))?.router).toMatchObject({ focusAreaId: 'fa_cards', evidence });
      const row = database.prepare('SELECT fields FROM work_state_entries WHERE list_name = ? AND fields LIKE ? ORDER BY id LIMIT 1').get(MY_FOCUS_LIST, '%"placed_by":"router"%') as { fields: string };
      expect(JSON.parse(row.fields)).toMatchObject({ anchor_conversation_key: key('a'), focus_area_id: 'fa_cards', placed_by: 'router', confidence: 0.8 });
      // The agent saw only the other two: the 0.79 pick as a hint, the failed call with none.
      expect(focusPrompts).toHaveLength(1);
      expect(focusPrompts[0].input.requests.map((entry: any) => [entry.anchor, entry.judgeSuggestion?.focusAreaId ?? null])).toEqual([[key('c'), 'fa_pricing'], [key('d'), null]]);
      expect(placing(writer.bodies)[1].placements.map(placement => placement.anchorConversationKey)).toEqual([key('c'), key('d')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

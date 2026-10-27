import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { focusAreaRowFields, placementRowFields } from '../../../../src/services/work-view/my-focus.mjs';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SyncApply, type SyncOp } from '../../../../src/services/sync/SyncApply.js';

let directory: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let nextId: number;

const CONVERSATION = JSON.stringify(['conversation', 'codex', 'conversation-1']);
const REQUEST_ID = CONVERSATION;

/** A row written the way the refresh or a seed script would: system-suggested, not through the route. */
function insertRow(fields: Record<string, unknown>, { at = Date.now(), device = null as string | null, project = 'home' } = {}) {
  const id = nextId++;
  source.prepare('INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch, origin_device_id, origin_local_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, project, 'my-focus', JSON.stringify(fields), at, device, device ? String(id) : null);
}
const suggestedArea = (focusAreaId: string, name: string, priorityRank: number) => focusAreaRowFields({
  focusAreaId, name, goal: `Make ${name} good.`, status: 'suggested', priorityRank, ownerRank: null,
  source: 'seed', mergedInto: null, evidence: '2026-10-26 09:00 | make the viewer good', decidedBy: 'system',
});

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-focus-test-'));
  const databasePath = join(directory, 'source.db');
  source = new Database(databasePath);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec(`
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER,
      origin_device_id TEXT, origin_local_id TEXT);
    CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT,
      content_session_id TEXT, memory_session_id TEXT, user_prompt TEXT, custom_title TEXT,
      status TEXT, started_at_epoch INTEGER, completed_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER,
      prompt_text TEXT, created_at_epoch INTEGER);
  `);
  // One human request: a conversation with a substantive ask.
  const now = Date.now();
  source.prepare('INSERT INTO sdk_sessions VALUES (1,?,?,?,?,?,?,?,?,?)').run('example-project', 'codex', 'conversation-1', 'memory', 'Build a local work viewer', null, 'active', now, null);
  source.prepare('INSERT INTO user_prompts VALUES (1,1,1,?,?)').run('Build a local work viewer', now);
  nextId = 1;
  insertRow(suggestedArea('fa_viewer', 'Viewer', 1), { at: now - 3000 });
  insertRow(suggestedArea('fa_endless', 'Endless Mode', 2), { at: now - 3000 });
  insertRow(suggestedArea('fa_community', 'Community', 3), { at: now - 3000 });
  const ledgerDir = join(directory, 'work-view');
  mkdirSync(ledgerDir);
  routes = new WorkViewRoutes({
    databasePath, reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir,
    homeProject: 'home', rulesFilePath: join(directory, 'MY-RULES.md'), claudeInstructionsPath: join(directory, 'claude', 'CLAUDE.md'),
    appendWorkStateEntry: ({ project, listName, fields }) => {
      source.prepare('INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?, ?)')
        .run(nextId++, project, listName, JSON.stringify(fields), Date.now() + nextId);
    },
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  source.close();
  rmSync(directory, { recursive: true, force: true });
});

async function snapshot() { return (await fetch(`${origin}/api/work-view`)).json(); }
function saveFocus(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/work-view/focus`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  });
}
const areaById = (view: any, id: string) => view.focusAreas.find((area: any) => area.focusAreaId === id);
const request = (view: any) => view.humanRequests.find((item: any) => item.id === REQUEST_ID);
const ownerRows = () => (source.prepare("SELECT project, fields FROM work_state_entries WHERE list_name = 'my-focus' AND origin_device_id IS NULL AND json_extract(fields, '$.decided_by') IS NOT 'system'").all() as { project: string; fields: string }[])
  .map(row => ({ project: row.project, fields: JSON.parse(row.fields) }));

describe('My Focus routes', () => {
  it('shows the areas in priority order and the request as not sorted yet', async () => {
    const view = await snapshot();
    expect(view.focusAreas.map((area: any) => area.name)).toEqual(['Viewer', 'Endless Mode', 'Community']);
    expect(request(view)).toMatchObject({ anchorConversationKey: CONVERSATION });
    expect('focusAreaId' in request(view)).toBe(false);
    // Areas and placements are never request cards.
    expect(view.humanRequests).toHaveLength(1);
  });

  it('refuses focus changes without the local viewer origin or a JSON body', async () => {
    expect((await saveFocus({ action: 'keep', focusAreaId: 'fa_viewer' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${origin}/api/work-view/focus`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(403);
    expect((await saveFocus({ action: 'keep', focusAreaId: 'fa_viewer' }, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
    expect(areaById(await snapshot(), 'fa_viewer').status).toBe('suggested');
  });

  it('rejects malformed focus changes', async () => {
    for (const body of [{}, { action: 'archive', focusAreaId: 'fa_viewer' }, { action: 'keep', focusAreaId: 'fa_viewer', extra: true },
      { action: 'rename', focusAreaId: 'fa_viewer', name: '   ' }, { action: 'rename', focusAreaId: 'fa_viewer', name: 'x'.repeat(81) },
      { action: 'reorder', focusAreaIds: [] }]) {
      expect((await saveFocus(body)).status).toBe(400);
    }
    expect((await saveFocus({ action: 'rename', focusAreaId: 'fa_viewer' })).status).toBe(400);
    expect((await saveFocus({ action: 'edit-goal', focusAreaId: 'fa_viewer' })).status).toBe(400);
    expect((await saveFocus({ action: 'merge', focusAreaId: 'fa_viewer' })).status).toBe(400);
    expect((await saveFocus({ action: 'merge', focusAreaId: 'fa_viewer', intoFocusAreaId: 'fa_viewer' })).status).toBe(400);
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_viewer', 'fa_viewer'] })).status).toBe(400);
    expect((await saveFocus({ action: 'move-request', requestId: REQUEST_ID })).status).toBe(400);
    expect((await saveFocus({ action: 'keep', focusAreaId: 'missing' })).status).toBe(404);
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_viewer', 'missing'] })).status).toBe(404);
    expect((await saveFocus({ action: 'move-request', requestId: 'missing', focusAreaId: 'fa_viewer' })).status).toBe(404);
    expect((await saveFocus({ action: 'move-request', requestId: REQUEST_ID, focusAreaId: 'missing' })).status).toBe(404);
    expect(ownerRows()).toEqual([]);
  });

  it('keeps, renames and edits the goal as owner rows under the home project, keeping the id', async () => {
    let response = await saveFocus({ action: 'keep', focusAreaId: 'fa_viewer' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(areaById(await response.json(), 'fa_viewer')).toMatchObject({ status: 'kept', decidedBy: 'owner' });
    await saveFocus({ action: 'rename', focusAreaId: 'fa_viewer', name: 'Live viewer' });
    response = await saveFocus({ action: 'edit-goal', focusAreaId: 'fa_viewer', goal: 'Show what agents did, sorted by area.' });
    expect(areaById(await response.json(), 'fa_viewer')).toMatchObject({
      name: 'Live viewer', goal: 'Show what agents did, sorted by area.', status: 'kept', source: 'seed', priorityRank: 1,
    });
    const rows = ownerRows();
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.project === 'home' && row.fields.task === 'Focus area: fa_viewer' && row.fields.decided_by === 'owner')).toBe(true);
  });

  it('dismisses and finishes areas, and puts a decided suggestion back', async () => {
    await saveFocus({ action: 'dismiss', focusAreaId: 'fa_community' });
    await saveFocus({ action: 'done', focusAreaId: 'fa_endless' });
    let view = await snapshot();
    expect(areaById(view, 'fa_community').status).toBe('dismissed');
    expect(areaById(view, 'fa_endless').status).toBe('done');
    await saveFocus({ action: 'restore-suggestion', focusAreaId: 'fa_community' });
    view = await snapshot();
    expect(areaById(view, 'fa_community')).toMatchObject({ status: 'suggested', decidedBy: 'owner-restore' });
    // Handed back: the next refresh's version of the area applies again.
    insertRow(suggestedArea('fa_community', 'Community and support', 3), { at: Date.now() + 60_000 });
    expect(areaById(await snapshot(), 'fa_community')).toMatchObject({ name: 'Community and support', decidedBy: 'system' });
  });

  it('merges an area, forwards its requests, refuses merging into a merged area, and undoes the merge', async () => {
    await saveFocus({ action: 'move-request', requestId: REQUEST_ID, focusAreaId: 'fa_community' });
    let view = await (await saveFocus({ action: 'merge', focusAreaId: 'fa_community', intoFocusAreaId: 'fa_viewer' })).json();
    expect(areaById(view, 'fa_community').mergedInto).toBe('fa_viewer');
    expect(request(view).focusAreaId).toBe('fa_viewer');
    expect((await saveFocus({ action: 'merge', focusAreaId: 'fa_endless', intoFocusAreaId: 'fa_community' })).status).toBe(409);
    expect((await saveFocus({ action: 'keep', focusAreaId: 'fa_community' })).status).toBe(409);
    view = await (await saveFocus({ action: 'restore-suggestion', focusAreaId: 'fa_community' })).json();
    expect(areaById(view, 'fa_community')).toMatchObject({ mergedInto: null, status: 'suggested' });
    expect(request(view).focusAreaId).toBe('fa_community');
  });

  it('refuses a rename that reuses a nav word, with the rule the seed uses', async () => {
    const response = await saveFocus({ action: 'rename', focusAreaId: 'fa_viewer', name: 'My Work' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/reuses the nav word "my work"/);
    expect(ownerRows()).toEqual([]);
    expect((await saveFocus({ action: 'rename', focusAreaId: 'fa_viewer', name: 'Work viewer' })).status).toBe(200);
  });

  it('reorders the kept areas by the owner\'s rank', async () => {
    for (const id of ['fa_viewer', 'fa_endless', 'fa_community']) await saveFocus({ action: 'keep', focusAreaId: id });
    const response = await saveFocus({ action: 'reorder', focusAreaIds: ['fa_community', 'fa_viewer', 'fa_endless'] });
    const view = await response.json();
    expect(view.focusAreas.map((area: any) => area.focusAreaId)).toEqual(['fa_community', 'fa_viewer', 'fa_endless']);
    expect(view.focusAreas.map((area: any) => area.ownerRank)).toEqual([1, 2, 3]);
  });

  it('orders kept areas only: a suggestion is never listed, never written as the owner\'s, and still takes refresh rows', async () => {
    await saveFocus({ action: 'keep', focusAreaId: 'fa_viewer' });
    await saveFocus({ action: 'keep', focusAreaId: 'fa_endless' });
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_endless'] })).status).toBe(400);
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_endless', 'fa_viewer', 'fa_community'] })).status).toBe(400);
    const before = ownerRows().length;
    const view = await (await saveFocus({ action: 'reorder', focusAreaIds: ['fa_endless', 'fa_viewer'] })).json();
    expect(view.focusAreas.slice(0, 2).map((area: any) => [area.focusAreaId, area.ownerRank])).toEqual([['fa_endless', 1], ['fa_viewer', 2]]);
    expect(ownerRows().slice(before).map((row: any) => row.fields.focus_area_id)).toEqual(['fa_endless', 'fa_viewer']);
    expect(areaById(view, 'fa_community')).toMatchObject({ status: 'suggested', ownerRank: null, decidedBy: 'system' });
  });

  it('leaves dismissed, done and merged areas out of the order', async () => {
    for (const id of ['fa_viewer', 'fa_endless', 'fa_community']) await saveFocus({ action: 'keep', focusAreaId: id });
    await saveFocus({ action: 'dismiss', focusAreaId: 'fa_community' });
    await saveFocus({ action: 'done', focusAreaId: 'fa_endless' });
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_viewer', 'fa_community'] })).status).toBe(400);
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_viewer', 'fa_endless'] })).status).toBe(400);
    expect((await saveFocus({ action: 'reorder', focusAreaIds: ['fa_viewer'] })).status).toBe(200);
  });

  it('moves a request to an area or Other, keyed by its anchor conversation, and a later router row does not undo it', async () => {
    let view = await (await saveFocus({ action: 'move-request', requestId: REQUEST_ID, focusAreaId: 'fa_endless' })).json();
    expect(request(view).focusAreaId).toBe('fa_endless');
    const [row] = ownerRows();
    expect(row.fields).toMatchObject({ task: `Placement: ${CONVERSATION}`, anchor_conversation_key: CONVERSATION, placed_by: 'owner', focus_area_id: 'fa_endless' });
    insertRow(placementRowFields({ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', placedBy: 'router', confidence: 0.9 }), { at: Date.now() + 60_000 });
    expect(request(await snapshot()).focusAreaId).toBe('fa_endless');
    view = await (await saveFocus({ action: 'move-request', requestId: REQUEST_ID, focusAreaId: 'other' })).json();
    expect(request(view).focusAreaId).toBe('other');
    await saveFocus({ action: 'dismiss', focusAreaId: 'fa_viewer' });
    expect((await saveFocus({ action: 'move-request', requestId: REQUEST_ID, focusAreaId: 'fa_viewer' })).status).toBe(409);
  });

  it('shows rows that arrived through sync from another device, in their write order', async () => {
    const now = Date.now();
    // The laptop kept and renamed the area and filed the request; SyncApply wrote these rows with their origin.
    insertRow(focusAreaRowFields({
      focusAreaId: 'fa_endless', name: 'Endless', goal: null, status: 'kept', priorityRank: 2, ownerRank: null,
      source: 'seed', mergedInto: null, evidence: null, decidedBy: 'owner',
    }), { at: now + 1000, device: 'laptop', project: 'laptop-home' });
    insertRow(placementRowFields({ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_endless', placedBy: 'owner' }), { at: now + 1000, device: 'laptop', project: 'laptop-home' });
    // An older system row that only arrived now does not undo the laptop's decision.
    insertRow(suggestedArea('fa_endless', 'Endless Mode (suggested again)', 2), { at: now - 1000, device: 'desktop', project: 'desktop-home' });
    const view = await snapshot();
    expect(areaById(view, 'fa_endless')).toMatchObject({ name: 'Endless', status: 'kept' });
    expect(request(view).focusAreaId).toBe('fa_endless');
  });

  describe('owner-goals suggestions', () => {
    const suggest = (areas: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/work-view/focus/owner-goals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ areas }),
    });
    const mined = (name: string, matches: string | null, rank = 1) => ({ name, goal: `What ${name} is for.`, rank, matches, evidence: 'From your prompts: asked 2 times, latest 2026-10-26 14:00.' });

    it('a new area is a system suggestion under a generated id; a matched area adds nothing and is answered with its id', async () => {
      const response = await suggest([mined('Releases', null, 1), mined('Viewer (mined)', 'fa_viewer', 2)]);
      expect(response.status).toBe(200);
      const { focusAreaIds } = await response.json();
      expect(focusAreaIds[0]).toMatch(/^fa_[0-9a-f]{12}$/);
      expect(focusAreaIds[1]).toBe('fa_viewer');
      const view = await snapshot();
      expect(areaById(view, focusAreaIds[0])).toMatchObject({ name: 'Releases', status: 'suggested', source: 'owner-goals', decidedBy: 'system', priorityRank: 1 });
      // The undecided Viewer suggestion takes the mined rank; its name is never changed by a run.
      expect(areaById(view, 'fa_viewer')).toMatchObject({ name: 'Viewer', priorityRank: 2, decidedBy: 'system' });
      expect(view.focusAreas).toHaveLength(4);
    });

    it('never changes an area the owner decided, and never lets the body write an owner decision', async () => {
      await saveFocus({ action: 'rename', focusAreaId: 'fa_viewer', name: 'My viewer' });
      await saveFocus({ action: 'dismiss', focusAreaId: 'fa_endless' });
      expect((await suggest([mined('Viewer', 'fa_viewer', 3), mined('Endless', 'fa_endless', 1)])).status).toBe(200);
      const view = await snapshot();
      expect(areaById(view, 'fa_viewer')).toMatchObject({ name: 'My viewer', priorityRank: 1, decidedBy: 'owner' });
      expect(areaById(view, 'fa_endless')).toMatchObject({ status: 'dismissed', priorityRank: 2, decidedBy: 'owner' });
      // Owner fields in the body are refused, not written.
      expect((await suggest([{ ...mined('Viewer', null), status: 'kept' }])).status).toBe(400);
      expect((await suggest([{ ...mined('Viewer', null), decidedBy: 'owner' }])).status).toBe(400);
    });

    it('refuses an unknown match, two areas matching one, and a browser page from another origin', async () => {
      const unknown = await suggest([mined('Releases', 'fa_nope')]);
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(await unknown.json())).toContain('fa_nope, which is not a saved focus area');
      expect((await suggest([mined('Viewer', 'fa_viewer'), mined('Viewer two', 'fa_viewer')])).status).toBe(400);
      expect((await suggest([mined('Releases', null)], { Origin: 'https://evil.example' })).status).toBe(403);
      expect((await suggest([mined('Releases', null)], { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
      expect((await snapshot()).focusAreas).toHaveLength(3);
    });
  });

  describe('focus step (record-focus)', () => {
    const BASIS = '0123456789abcdef';
    const route = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/work-view/focus/router`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
    });
    const focusRows = () => (source.prepare("SELECT fields FROM work_state_entries WHERE list_name = 'my-focus'").all() as { fields: string }[]).length;
    const proposal = (change: Record<string, unknown> = {}) => ({ kind: 'promote', name: 'Work viewer', goal: 'Show agent work.', about: 'The viewer and its pages.', evidence: 'Several asks.', sameAs: null, requests: [{ anchorConversationKey: CONVERSATION, basis: BASIS }], ...change });

    it('writes router placements and suggested areas as the system; the owner\'s move still wins', async () => {
      let response = await route({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', basis: BASIS, evidence: 'A local work viewer.' }], proposals: [] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ placed: 1, focusAreaIds: [] });
      expect(request(await snapshot()).focusAreaId).toBe('fa_viewer');
      await saveFocus({ action: 'move-request', requestId: REQUEST_ID, focusAreaId: 'fa_community' });
      response = await route({ placements: [], proposals: [proposal()] });
      const { focusAreaIds } = await response.json();
      const view = await snapshot();
      expect(areaById(view, focusAreaIds[0])).toMatchObject({ name: 'Work viewer', about: 'The viewer and its pages.', status: 'suggested', source: 'promotion', decidedBy: 'system' });
      expect(request(view).focusAreaId).toBe('fa_community');
    });

    it('a proposal that is a live area places its requests there; one that is a dismissed area is refused', async () => {
      const areas = (await snapshot()).focusAreas.length;
      const response = await route({ placements: [], proposals: [proposal({ sameAs: 'fa_endless' })] });
      expect(await response.json()).toEqual({ placed: 1, focusAreaIds: [] });
      const view = await snapshot();
      expect(view.focusAreas).toHaveLength(areas);
      expect(request(view).focusAreaId).toBe('fa_endless');
      await saveFocus({ action: 'dismiss', focusAreaId: 'fa_community' });
      const before = focusRows();
      const dismissed = await route({ placements: [], proposals: [proposal({ sameAs: 'fa_community' })] });
      expect(dismissed.status).toBe(400);
      expect(JSON.stringify(await dismissed.json())).toContain('the owner dismissed; it is never proposed again');
      expect(focusRows()).toBe(before);
    });

    it('refuses an unknown or dismissed area, a malformed body and a foreign page, writing nothing', async () => {
      await saveFocus({ action: 'dismiss', focusAreaId: 'fa_endless' });
      const before = focusRows();
      const unknown = await route({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_nope', basis: BASIS, evidence: 'x' }], proposals: [] });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(await unknown.json())).toContain('fa_nope, which is not a focus area');
      const dismissed = await route({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_endless', basis: BASIS, evidence: 'x' }], proposals: [] });
      expect(dismissed.status).toBe(400);
      expect(JSON.stringify(await dismissed.json())).toContain('fa_endless, which no longer takes requests');
      expect((await route({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', basis: BASIS, evidence: 'x', placedBy: 'owner' }], proposals: [] })).status).toBe(400);
      expect((await route({ placements: [], proposals: [proposal({ status: 'kept' })] })).status).toBe(400);
      expect((await route({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', basis: 'not-a-basis', evidence: 'x' }], proposals: [] })).status).toBe(400);
      expect((await route({ placements: [], proposals: [] }, { Origin: 'https://evil.example' })).status).toBe(403);
      expect(focusRows()).toBe(before);
    });

    it('a row too long to save is a refusal before any write (400); a failure while writing is not (503), and is never a TypeError', async () => {
      // An anchor inside the route's bound whose placement row (task + anchor) does not fit one work-state row.
      const long = 'x'.repeat(1500);
      const before = focusRows();
      const tooLong = await route({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'other', basis: BASIS, evidence: 'Fits.' }, { anchorConversationKey: long, focusAreaId: 'other', basis: BASIS, evidence: 'Too long.' }], proposals: [] });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(await tooLong.json())).toContain('too long to save');
      expect(focusRows()).toBe(before);
      expect(() => routes.recordRouterFocus({ placements: [{ anchorConversationKey: long, focusAreaId: 'other', basis: BASIS, evidence: 'x' }], proposals: [] })).toThrow(TypeError);
      // The writer fails on the second row, as a TypeError: the error that reaches the refresh is a plain Error.
      const append = (routes as any).appendWorkStateEntry;
      let calls = 0;
      (routes as any).appendWorkStateEntry = (entry: unknown) => { if (++calls === 2) throw new TypeError('database is locked'); append(entry); };
      const body = { placements: [], proposals: [proposal()] };
      let thrown: unknown;
      try { routes.recordRouterFocus(body as any); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toBe('Saving the focus step stopped after 1 of 2 rows: database is locked');
      calls = 0;
      const response = await route(body);
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).toContain('stopped after 1 of 2 rows');
    });

    it('the refresh writes in-process through the same check', () => {
      expect(() => routes.recordRouterFocus({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_nope', basis: BASIS, evidence: 'x' }], proposals: [] })).toThrow(TypeError);
      expect(routes.recordRouterFocus({ placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'other', basis: BASIS, evidence: 'Fits no area.' }], proposals: [], otherPassHash: BASIS })).toEqual({ placed: 1, focusAreaIds: [] });
    });
  });

  it('is unavailable without a work-state writer', async () => {
    routes.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    routes = new WorkViewRoutes({ databasePath: join(directory, 'source.db'), reviewPath: join(directory, 'review2.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: null, homeProject: 'home', rulesFilePath: join(directory, 'MY-RULES.md'), claudeInstructionsPath: join(directory, 'claude', 'CLAUDE.md') });
    const app = express();
    app.use(express.json());
    routes.setupRoutes(app);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    origin = `http://127.0.0.1:${address.port}`;
    expect((await saveFocus({ action: 'keep', focusAreaId: 'fa_viewer' })).status).toBe(503);
  });
});

describe('My Focus rows pulled through cloud sync', () => {
  it('shows an area and a placement that SyncApply.applyOps wrote from another device', async () => {
    const syncDirectory = mkdtempSync(join(tmpdir(), 'work-view-focus-sync-test-'));
    const databasePath = join(syncDirectory, 'claude-mem.db');
    const database = new Database(databasePath);
    const store = new SessionStore(database);
    // The request on this device: a conversation with a substantive ask.
    const now = Date.now();
    database.prepare("INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status) VALUES ('conversation-1', 'memory', 'example-project', 'codex', 'Build a local work viewer', ?, ?, 'active')")
      .run(new Date(now).toISOString(), now);
    store.saveUserPrompt('conversation-1', 1, 'Build a local work viewer');
    const op = (originId: string, fields: Record<string, unknown>, seq: number): SyncOp => ({
      seq: String(seq), kind: 'work_state', origin_device: 'laptop', origin_id: originId, rev: '1',
      // The pull side hands apply the stored shape: fields as JSON text (SyncClient localPayload).
      body: JSON.stringify({ project: 'laptop-home', list_name: 'my-focus', fields: JSON.stringify(fields), created_at: new Date(now).toISOString(), created_at_epoch: now }),
      server_ts: now,
    });
    const result = new SyncApply(database, { deviceId: 'desktop', now: () => now }).applyOps([
      op('1', focusAreaRowFields({ focusAreaId: 'fa_viewer', name: 'Viewer', goal: null, status: 'kept', priorityRank: 1, ownerRank: null, source: 'seed', mergedInto: null, evidence: null, decidedBy: 'owner' }), 1),
      op('2', placementRowFields({ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', placedBy: 'owner' }), 2),
    ], { epoch: 'epoch-1' });
    expect(result.applied).toBe(2);
    const syncRoutes = new WorkViewRoutes({
      databasePath, reviewPath: join(syncDirectory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: null,
      getLocalDeviceId: () => 'desktop', homeProject: 'home', rulesFilePath: join(syncDirectory, 'MY-RULES.md'), claudeInstructionsPath: join(syncDirectory, 'claude', 'CLAUDE.md'),
    });
    const app = express();
    app.use(express.json());
    syncRoutes.setupRoutes(app);
    let syncServer: Server | null = null;
    try {
      await new Promise<void>(resolve => { syncServer = app.listen(0, '127.0.0.1', resolve); });
      const address = syncServer!.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      const view = await (await fetch(`http://127.0.0.1:${address.port}/api/work-view`)).json();
      expect(view.focusAreas).toEqual([expect.objectContaining({ focusAreaId: 'fa_viewer', name: 'Viewer', status: 'kept', decidedBy: 'owner' })]);
      expect(request(view)).toMatchObject({ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer' });
    } finally {
      syncRoutes.close();
      if (syncServer) await new Promise<void>((resolve, reject) => syncServer!.close(error => error ? reject(error) : resolve()));
      database.close();
      rmSync(syncDirectory, { recursive: true, force: true });
    }
  });
});

describe('My Focus seed route', () => {
  const postSeed = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/work-view/focus/seed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  const databasePath = () => join(directory, 'source.db');
  const BASIS = '0123456789abcdef';
  const apply = () => ({ action: 'apply', databasePath: databasePath(),
    areas: [{ key: 'v', name: 'Live Viewer', goal: 'g', about: 'a', priorityRank: 1, evidence: 'Seed: viewer' }],
    placements: [{ anchorConversationKey: CONVERSATION, area: 'v', confidence: 0.9, basis: BASIS, evidence: 'Seed: Jev routed this request to line "viewer" (p=0.9).' }] });
  const myFocusRows = () => (source.prepare("SELECT count(*) AS n FROM work_state_entries WHERE list_name = 'my-focus'").get() as { n: number }).n;

  it('refuses foreign, forwarded, malformed and wrong-database writes without writing', async () => {
    const before = myFocusRows();
    expect((await postSeed(apply(), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await postSeed(apply(), { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
    expect((await postSeed({ ...apply(), extra: 1 })).status).toBe(400);
    expect((await postSeed({ ...apply(), placements: [{ ...apply().placements[0], confidence: 2 }] })).status).toBe(400);
    expect((await postSeed({ ...apply(), placements: [{ ...apply().placements[0], basis: 'nope' }] })).status).toBe(400);
    const { databasePath: _omitted, ...withoutPath } = apply();
    expect((await postSeed(withoutPath)).status).toBe(400);
    const wrong = await postSeed({ ...apply(), databasePath: join(directory, 'live.db') });
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error).toMatch(/This worker serves .*source\.db, not .*live\.db/);
    // The fixture areas are live seed areas: a second seed is refused.
    const again = await postSeed(apply());
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already applied/);
    expect(myFocusRows()).toBe(before);
  });

  it('undoes the fixture seed with system rows, then applies a new seed', async () => {
    insertRow(placementRowFields({ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', placedBy: 'router', basis: BASIS, evidence: 'Seed: viewer' }));
    expect(request(await snapshot()).focusAreaId).toBe('fa_viewer');
    const undone = await postSeed({ action: 'undo', databasePath: databasePath(), focusAreaIds: ['fa_viewer', 'fa_endless', 'fa_community'],
      placements: [{ anchorConversationKey: CONVERSATION, focusAreaId: 'fa_viewer', basis: BASIS }] });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ action: 'undo', rows: 4, withdrawn: ['fa_viewer', 'fa_endless', 'fa_community'], cleared: [CONVERSATION] });
    let view = await snapshot();
    expect([areaById(view, 'fa_viewer').status, areaById(view, 'fa_viewer').decidedBy]).toEqual(['dismissed', 'system']);
    expect('focusAreaId' in request(view)).toBe(false);

    const applied = await postSeed(apply());
    expect(applied.status).toBe(200);
    const result = await applied.json();
    const created = result.created[0];
    expect(created).toMatch(/^fa_/);
    expect(result).toMatchObject({ action: 'apply', rows: 2, created: [created], skipped: [] });
    expect(result.placed).toEqual([{ anchorConversationKey: CONVERSATION, focusAreaId: created, basis: BASIS }]);
    view = await snapshot();
    expect(areaById(view, created)).toMatchObject({ name: 'Live Viewer', status: 'suggested', source: 'seed', decidedBy: 'system' });
    expect(request(view).focusAreaId).toBe(created);
    // Nothing the seed route wrote is an owner row.
    expect(ownerRows().filter(row => row.fields.decided_by === 'owner' || row.fields.placed_by === 'owner')).toEqual([]);
  });
});

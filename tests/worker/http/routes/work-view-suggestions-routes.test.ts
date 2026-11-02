import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { groupIdFor, readLedger } from '../../../../src/services/work-view/request-groups.mjs';

const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const A = key('a'), C = key('c');
const RELEASE_CARDS = groupIdFor(A), SPACING = groupIdFor(C);
const DAY = 86400000;
const EVIDENCE = 'Judge jev (typesafe/jev-1.14): picked "Release cards" over 1 open request (p 0.70); the check "continues that request" scored 0.63.';

let directory: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let ledgerDir: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-suggestions-test-'));
  const databasePath = join(directory, 'source.db');
  source = new Database(databasePath);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec(`
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
    CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT,
      user_prompt TEXT, custom_title TEXT, status TEXT, started_at_epoch INTEGER, completed_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, content_session_id TEXT, agent_id TEXT, agent_type TEXT,
      prompt_number INTEGER, title TEXT, subtitle TEXT, type TEXT, created_at_epoch INTEGER, narrative TEXT);
    CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, prompt_number INTEGER, request TEXT, completed TEXT, next_steps TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, agent_id TEXT, agent_type TEXT, session_db_id INTEGER, memory_session_id TEXT,
      content_session_id TEXT, prompt_number INTEGER, tool_input TEXT, created_at_epoch INTEGER, tool_name TEXT);
  `);
  const now = Date.now();
  const session = source.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run(1, 'repo', 'claude', 'a', 'm1', 'Build the release cards', null, 'active', now - 3 * DAY, null);
  session.run(2, 'repo', 'claude', 'c', 'm2', 'Fix the card spacing', null, 'active', now - DAY, null);
  const prompt = source.prepare('INSERT INTO user_prompts VALUES (?, ?, ?, ?, ?)');
  prompt.run(1, 1, 1, 'Build the release cards', now - 3 * DAY);
  prompt.run(2, 2, 1, 'Fix the card spacing', now - DAY);
  ledgerDir = join(directory, 'work-view');
  mkdirSync(ledgerDir);
  // The judge's mid-band pick: c is its own request, with "Looks like part of Release cards" waiting for the owner.
  writeFileSync(join(ledgerDir, 'request-groups.json'), JSON.stringify({
    version: 1, updatedAt: null,
    conversations: { [A]: RELEASE_CARDS, [C]: SPACING },
    groups: {
      [RELEASE_CARDS]: { title: 'Release cards', anchor: A, projectRoot: 'repo', links: [], decidedAt: null, anchorAsk: null },
      [SPACING]: { title: 'Fix the card spacing', anchor: C, projectRoot: 'repo', links: [], decidedAt: null, anchorAsk: null },
    },
    ignored: {},
    suggestions: { [C]: { requestId: RELEASE_CARDS, confidence: 0.63, evidence: EVIDENCE, judge: 'jev', at: new Date(now).toISOString(), status: 'open' } },
  }));
  routes = new WorkViewRoutes({ databasePath, reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir, setupStatePath: join(directory, 'setup-state.json') });
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
function answer(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/work-view/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
}
const cardOf = (view: any, conversationKey: string) => view.humanRequests.find((request: any) => request.conversationKeys.includes(conversationKey));

describe('request suggestions', () => {
  it('the snapshot carries the judge\'s suggestion on the conversation\'s own card', async () => {
    const view = await snapshot();
    expect(view.suggestions).toEqual([{ conversationKey: C, requestId: RELEASE_CARDS, requestTitle: 'Release cards', confidence: 0.63, evidence: EVIDENCE, judge: 'jev', at: expect.any(String) }]);
    expect(view.humanRequests).toHaveLength(2);
    expect(cardOf(view, C).suggestion).toEqual(view.suggestions[0]);
    expect(cardOf(view, A).suggestion).toBeUndefined();
  });

  it('Join moves the conversation into the suggested request through the ledger', async () => {
    const before = cardOf(await snapshot(), A).contentFingerprint;
    const response = await answer({ conversationKey: C, action: 'join' });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.suggestions).toEqual([]);
    expect(view.humanRequests).toHaveLength(1);
    expect(new Set(view.humanRequests[0].conversationKeys)).toEqual(new Set([A, C]));
    expect(view.humanRequests[0].title).toBe('Release cards');
    expect(view.humanRequests[0].suggestion).toBeUndefined();
    const ledger = readLedger(ledgerDir);
    expect(ledger.groups.conversations[C]).toBe(RELEASE_CARDS);
    expect(ledger.groups.groups[SPACING]).toBeUndefined();
    expect(ledger.groups.groups[RELEASE_CARDS].links).toEqual([{ kind: 'judge', conversations: [A, C], evidence: `Owner joined on the judge's suggestion. ${EVIDENCE}` }]);
    expect(ledger.groups.suggestions[C]).toMatchObject({ status: 'joined', resolvedAt: expect.any(String) });
    // A suggestion is answered once.
    expect((await answer({ conversationKey: C, action: 'join' })).status).toBe(404);
    // The merged card is new recorded content: a check on the old card does not carry over.
    expect(view.humanRequests[0].contentFingerprint).not.toBe(before);
  });

  it('Not this keeps the conversation as its own request and records that the owner declined', async () => {
    const response = await answer({ conversationKey: C, action: 'not-this' });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.suggestions).toEqual([]);
    expect(view.humanRequests).toHaveLength(2);
    expect(cardOf(view, C).suggestion).toBeUndefined();
    const ledger = readLedger(ledgerDir);
    expect(ledger.groups.conversations[C]).toBe(SPACING);
    expect(ledger.groups.suggestions[C]).toMatchObject({ status: 'declined', evidence: `Owner declined: not part of "Release cards". ${EVIDENCE}` });
    expect((await answer({ conversationKey: C, action: 'not-this' })).status).toBe(404);
  });

  it('refuses foreign pages, malformed bodies and unknown suggestions, and changes nothing', async () => {
    expect((await answer({ conversationKey: C, action: 'join' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${origin}/api/work-view/suggestions`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(403);
    for (const body of [{}, { conversationKey: C }, { conversationKey: C, action: 'merge' }, { conversationKey: C, action: 'join', extra: true }]) {
      expect((await answer(body)).status).toBe(400);
    }
    expect((await answer({ conversationKey: key('zzz'), action: 'join' })).status).toBe(404);
    expect((await answer({ conversationKey: A, action: 'not-this' })).status).toBe(404);
    expect(readLedger(ledgerDir).groups.suggestions[C].status).toBe('open');
    expect((await snapshot()).suggestions).toHaveLength(1);
  });
});

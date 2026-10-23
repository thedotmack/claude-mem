import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { myRulesImportLine, WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { ruleIdForPreference } from '../../../../src/services/work-view/my-rules.mjs';
import { emitContextInvalidation } from '../../../../src/shared/context-invalidation.js';

let directory: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let rulesFilePath: string;
let claudeInstructionsPath: string;
let nextId: number;

const PREFERENCE = 'Never open draft pull requests.';
const SUGGESTED_ID = ruleIdForPreference(PREFERENCE);

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-rules-test-'));
  const databasePath = join(directory, 'source.db');
  source = new Database(databasePath);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  nextId = 1;
  const ledgerDir = join(directory, 'work-view');
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, 'story.json'), JSON.stringify({
    narrative: 'Two requests shipped.', writtenAt: '2026-10-19T09:32:04.876Z',
    preferences: [{ preference: PREFERENCE, kind: 'correction', supportCount: 2, quotes: [{ quote: 'no draft PRs please', at: '2026-10-18T10:00:00Z' }] }],
  }));
  rulesFilePath = join(directory, 'MY-RULES.md');
  claudeInstructionsPath = join(directory, 'claude', 'CLAUDE.md');
  routes = new WorkViewRoutes({
    databasePath, reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir,
    homeProject: 'home', rulesFilePath, claudeInstructionsPath,
    appendWorkStateEntry: ({ project, listName, fields }) => {
      source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)').run(nextId++, project, listName, JSON.stringify(fields), Date.now() + nextId);
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
function saveRule(body: unknown) {
  return fetch(`${origin}/api/work-view/rules`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
}
const ruleById = (view: any, id: string) => view.rules.find((rule: any) => rule.ruleId === id);

describe('My Rules routes', () => {
  it('suggests rules from the build story and reports the rules file', async () => {
    const view = await snapshot();
    expect(ruleById(view, SUGGESTED_ID)).toMatchObject({ status: 'suggested', setBy: 'learned', when: '', then: PREFERENCE, timesSeen: 2, scopeId: 'everywhere' });
    expect(view.rulesLearning).toMatchObject({ preferencesFound: 1, newSuggestions: 1, reviewsRead: 0 });
    expect(view.rulesFile).toMatchObject({ approvedCount: 0, loadedInClaudeCode: false });
  });

  it('refuses rule changes without the local viewer origin', async () => {
    const response = await fetch(`${origin}/api/work-view/rules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ action: 'approve', ruleId: SUGGESTED_ID }),
    });
    expect(response.status).toBe(403);
    expect((await fetch(`${origin}/api/work-view/rules`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(403);
    expect(ruleById(await snapshot(), SUGGESTED_ID).status).toBe('suggested');
  });

  it('rejects malformed rule changes', async () => {
    for (const body of [{}, { action: 'approve', ruleId: SUGGESTED_ID, extra: true }, { action: 'add', rule: { scopeTier: 'everywhere', scopeName: '', when: '', then: '' } }, { action: 'delete', ruleId: SUGGESTED_ID }]) {
      expect((await saveRule(body)).status).toBe(400);
    }
    expect((await saveRule({ action: 'add' })).status).toBe(400);
    expect((await saveRule({ action: 'approve', ruleId: 'missing' })).status).toBe(404);
  });

  it('approves a suggestion, saves it as a my-rules row and writes MY-RULES.md', async () => {
    const response = await saveRule({ action: 'approve', ruleId: SUGGESTED_ID });
    expect(response.status).toBe(200);
    expect(ruleById(await response.json(), SUGGESTED_ID)).toMatchObject({ status: 'on', setBy: 'approved' });
    const row = source.prepare("SELECT project, fields FROM work_state_entries WHERE list_name = 'my-rules'").get() as { project: string; fields: string };
    expect(row.project).toBe('home');
    expect(JSON.parse(row.fields)).toMatchObject({ task: `Rule: ${SUGGESTED_ID}`, status: 'on', set_by: 'approved', quotes: '2026-10-18 10:00 | no draft PRs please' });
    expect(readFileSync(rulesFilePath, 'utf8')).toContain(`## Everywhere\n\n- ${PREFERENCE}`);
    const view = await snapshot();
    expect(view.rulesFile.approvedCount).toBe(1);
    // My Rules is never a request card.
    expect(view.humanRequests).toEqual([]);
  });

  it('edits, turns off, adds and replaces rules; off rules leave MY-RULES.md', async () => {
    await saveRule({ action: 'approve', ruleId: SUGGESTED_ID });
    await saveRule({ action: 'edit', ruleId: SUGGESTED_ID, rule: { scopeTier: 'project', scopeName: 'claude-mem', when: 'you open a pull request', then: 'Never open it as a draft.' } });
    expect(readFileSync(rulesFilePath, 'utf8')).toContain('## In claude-mem\n\n- When you open a pull request: never open it as a draft.');
    await saveRule({ action: 'turn-off', ruleId: SUGGESTED_ID });
    expect(readFileSync(rulesFilePath, 'utf8')).not.toContain('draft');
    const added = await (await saveRule({ action: 'add', rule: { scopeTier: 'situation', scopeName: 'When I am frustrated', when: '', then: 'Stop and ask what I want.' } })).json();
    const own = added.rules.find((rule: any) => rule.setBy === 'owner');
    expect(own).toMatchObject({ status: 'on', source: 'you', scopeId: 'situation:When I am frustrated' });
    const replaced = await (await saveRule({ action: 'replace', ruleId: own.ruleId, rule: { scopeTier: 'situation', scopeName: 'When I am frustrated', when: '', then: 'Stop, restate what I want, and wait.' } })).json();
    expect(ruleById(replaced, own.ruleId)).toMatchObject({ status: 'replaced' });
    expect(ruleById(replaced, ruleById(replaced, own.ruleId).replacedBy).then).toBe('Stop, restate what I want, and wait.');
    expect(readFileSync(rulesFilePath, 'utf8')).toContain('## When I am frustrated\n\n- Stop, restate what I want, and wait.');
    expect(replaced.ruleScopes.map((scope: any) => scope.id)).toEqual(['everywhere', 'project:claude-mem', 'situation:When I am frustrated']);
  });

  it('puts a decided suggestion back, and refuses toggling a suggestion', async () => {
    expect((await saveRule({ action: 'turn-on', ruleId: SUGGESTED_ID })).status).toBe(409);
    await saveRule({ action: 'dismiss', ruleId: SUGGESTED_ID });
    expect(ruleById(await snapshot(), SUGGESTED_ID).status).toBe('dismissed');
    await saveRule({ action: 'restore-suggestion', ruleId: SUGGESTED_ID });
    expect(ruleById(await snapshot(), SUGGESTED_ID)).toMatchObject({ status: 'suggested', setBy: 'learned', then: PREFERENCE });
  });

  it('adds the MY-RULES.md import to the user-level CLAUDE.md once', async () => {
    const load = () => fetch(`${origin}/api/work-view/rules/load-in-claude-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
    expect((await fetch(`${origin}/api/work-view/rules/load-in-claude-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await (await load()).json()).rulesFile.loadedInClaudeCode).toBe(true);
    await load();
    const instructions = readFileSync(claudeInstructionsPath, 'utf8');
    // The import names the file this worker writes (here a custom folder), not a fixed ~/.claude-mem path.
    expect(myRulesImportLine(rulesFilePath)).toBe(`@${rulesFilePath}`);
    expect(instructions.split(myRulesImportLine(rulesFilePath)).length - 1).toBe(1);
    expect(existsSync(rulesFilePath)).toBe(true);
  });

  it('loading rules rebuilds an existing MY-RULES.md from the saved rules', async () => {
    await saveRule({ action: 'approve', ruleId: SUGGESTED_ID });
    writeFileSync(rulesFilePath, '# stale rules from before a sync\n');
    await fetch(`${origin}/api/work-view/rules/load-in-claude-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
    expect(readFileSync(rulesFilePath, 'utf8')).toContain(`- ${PREFERENCE}`);
  });

  it('rebuilds MY-RULES.md when rule rows arrive through sync', async () => {
    await saveRule({ action: 'approve', ruleId: SUGGESTED_ID });
    expect(readFileSync(rulesFilePath, 'utf8')).toContain(PREFERENCE);
    // Another device turned the rule off; sync writes the row directly, not through the rules route.
    const fields = JSON.parse((source.prepare("SELECT fields FROM work_state_entries WHERE list_name = 'my-rules' ORDER BY id DESC LIMIT 1").get() as { fields: string }).fields);
    source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)').run(nextId++, 'home', 'my-rules', JSON.stringify({ ...fields, status: 'off' }), Date.now() + 1000);
    emitContextInvalidation('all', 'SyncApply.applyOps');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(readFileSync(rulesFilePath, 'utf8')).not.toContain(PREFERENCE);
  });

  it('takes the latest decision when one rule is saved in several projects\' my-rules lists', async () => {
    await saveRule({ action: 'approve', ruleId: SUGGESTED_ID });
    const fields = JSON.parse((source.prepare("SELECT fields FROM work_state_entries WHERE list_name = 'my-rules' ORDER BY id DESC LIMIT 1").get() as { fields: string }).fields);
    const now = Date.now();
    // A computer with another home folder name turned it off later; its list sorts before 'home'.
    source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)').run(nextId++, 'aaa-laptop-home', 'my-rules', JSON.stringify({ ...fields, status: 'off' }), now + 5000);
    expect(ruleById(await snapshot(), SUGGESTED_ID).status).toBe('off');
    // And an older row in another list does not undo it.
    source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)').run(nextId++, 'zzz-desktop-home', 'my-rules', JSON.stringify({ ...fields, status: 'on' }), now - 5000);
    expect(ruleById(await snapshot(), SUGGESTED_ID).status).toBe('off');
  });
});

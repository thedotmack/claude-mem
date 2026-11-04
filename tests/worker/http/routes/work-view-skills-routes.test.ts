import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SKILL_BYTES, sha256, SkillCatalog } from '../../../../src/services/skills/catalog.js';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';

const original = '\uFEFF# Instructions\r\n\r\nKeep these bytes.\r\n';
let home: string;
let file: string;
let origin: string;
let skills: string;
let routes: WorkViewRoutes;
let server: Server;
let catalog: SkillCatalog;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'my-skills-routes-'));
  const folder = join(home, '.claude', 'skills', 'one');
  await mkdir(folder, { recursive: true });
  file = join(folder, 'SKILL.md');
  await writeFile(file, original);
  const databasePath = join(home, 'source.db');
  const db = new Database(databasePath);
  db.run('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  db.close();
  catalog = new SkillCatalog({ home, extraFolders: [], projectDirectories: () => [], excludedProjects: '' });
  routes = new WorkViewRoutes({ databasePath, reviewPath: ':memory:', ledgerDir: null, humanCopy: null, autoRefresh: null, skillCatalog: catalog });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No test port');
  origin = 'http://127.0.0.1:' + addr.port;
  skills = origin + '/api/work-view/skills';
});

afterEach(async () => {
  routes.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

async function openSkill() {
  const list = await fetch(skills);
  expect(list.status).toBe(200);
  expect(list.headers.get('cache-control')).toContain('no-store');
  const { skills: entries, issues } = await list.json();
  expect(issues).toEqual([]);
  expect(entries).toHaveLength(1);
  const url = skills + '/' + entries[0].id;
  const opened = await fetch(url);
  expect(opened.status).toBe(200);
  const document = await opened.json();
  expect(Object.keys(document).sort()).toEqual(['entry', 'revision', 'text']);
  expect(document).toMatchObject({ entry: { location: file, editable: true }, text: original, revision: sha256(original) });
  return { url, revision: document.revision as string };
}

function save(url: string, body: unknown, headers?: Record<string, string>) {
  return fetch(url + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
}

describe('local skill files', () => {
  it('opens the feed without collecting skills, and refuses foreign origins before collecting', async () => {
    const scan = spyOn(catalog, 'refresh');
    expect((await fetch(origin + '/api/work-view')).status).toBe(200);
    for (const headers of [{ Origin: 'https://foreign.example' }, { Origin: origin.replace('127.0.0.1', 'localhost') },
      { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Forwarded-For': '203.0.113.1' }]) {
      const response = await fetch(skills, { headers });
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(scan).toHaveBeenCalledTimes(0);
    await openSkill();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('saves through the opaque ID, preserves the Markdown and acknowledges an identical retry', async () => {
    const { url, revision } = await openSkill();
    const text = original.replace('Keep', 'Retain');
    const body = { expectedRevision: revision, text };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await save(url, body);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toMatchObject({ revision: sha256(text), entry: { editable: true, location: file } });
    }
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('keeps an external change and rejects simultaneous different saves based on one revision', async () => {
    const { url, revision } = await openSkill();
    const outcomes = await Promise.all(['First', 'Second'].map(text => save(url, { expectedRevision: revision, text })));
    expect(outcomes.map(response => response.status).sort()).toEqual([200, 409]);
    await writeFile(file, 'My terminal edit');
    const stale = await save(url, { expectedRevision: revision, text: 'Old browser draft' });
    expect(stale.status).toBe(409);
    expect(await readFile(file, 'utf8')).toBe('My terminal edit');
  });

  it('checks request shape, source scope, document validity and current permission', async () => {
    const { url, revision } = await openSkill();
    const body = { expectedRevision: revision, text: 'changed' };
    expect((await save(url, { ...body, path: file })).status).toBe(400);
    expect((await save(url, { ...body, expectedRevision: 'bad-hash' })).status).toBe(400);
    expect((await save(url, body, { Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await save(url, body, { 'Content-Type': 'text/plain' })).status).toBe(403);
    expect((await fetch(skills + '/%2e%2e%2fetc%2fpasswd')).status).toBe(400);
    expect((await fetch(skills + '/' + 'f'.repeat(64))).status).toBe(404);
    expect((await save(url, { ...body, text: '---\nbad: [\n---\nbody' })).status).toBe(422);
    expect((await save(url, { ...body, text: 'é'.repeat(MAX_SKILL_BYTES / 2 + 1) })).status).toBe(413);
    await chmod(file, 0o444);
    expect((await save(url, body)).status).toBe(403);
    expect(await readFile(file, 'utf8')).toBe(original);
  });
});

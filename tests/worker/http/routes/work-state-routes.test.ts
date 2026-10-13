// POST /api/work-state/entries appends one entry under the checkout's primary
// project key and answers with what is still open in the list; GET /api/work-state
// reads every key the checkout reads. These are what the work_state_write and
// work_state_read MCP tools call with the session's cwd.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import express from 'express';
import {
  MAX_WORK_STATE_FIELDS_JSON_CHARS,
  WorkStateRoutes,
} from '../../../../src/services/worker/http/routes/WorkStateRoutes.js';
import { buildWorkStateContextSection, WORK_STATE_SECTION_CHARACTER_LIMIT } from '../../../../src/services/context/sections/WorkStateRenderer.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { logger } from '../../../../src/utils/logger.js';

let server: Server | undefined;
let port = 0;
let store: SessionStore;
let checkout: string;
let project: string;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(async () => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
  store = new SessionStore(':memory:');
  checkout = mkdtempSync(join(tmpdir(), 'work-state-checkout-'));
  project = getProjectContext(checkout).primary;

  const app = express();
  app.use(express.json());
  new WorkStateRoutes({ getSessionStore: () => store } as any).setupRoutes(app);
  ModeManager.getInstance().loadMode('code');
  new SearchRoutes({ getSessionStore: () => store } as any).setupRoutes(app);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('work-state test server did not bind a port'));
        return;
      }
      port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  loggerSpies.forEach(spy => spy.mockRestore());
  delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
  delete process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(err => (err ? reject(err) : resolve()));
    server = undefined;
  });
  store.close();
  rmSync(checkout, { recursive: true, force: true });
});

function write(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/work-state/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function read(query: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/work-state?${new URLSearchParams(query)}`);
}

describe('WorkStateRoutes', () => {
  it('reads open work state from a project adopted into the checkout', async () => {
    const adoptedProject = `${project}-merged-worktree`;
    const session = store.createSDKSession('adopted-host', adoptedProject, 'prompt');
    store.updateMemorySessionId(session, 'adopted-observer');
    store.storeObservation('adopted-observer', adoptedProject, {
      type: 'discovery', title: 'Adopted finding', subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: [], files_modified: [],
    });
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE project = ?').run(project, adoptedProject);
    store.appendWorkStateEntry({ project: adoptedProject, listName: 'release', fields: { task: 'finish migration', status: 'doing' } });

    const response = await read({ cwd: checkout });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('[doing] finish migration');
    expect(store.getWorkStateEntries([project]).map(entry => entry.project)).toEqual([adoptedProject]);
    expect(store.getWorkStateEntries(['unrelated-project'])).toEqual([]);
  });

  it("saves an entry under the checkout's project and answers with what is still open in the list", async () => {
    await write({ cwd: checkout, list: 'release', fields: { version: '13.25.2', blocked_on: 'npm token' } });
    await write({ cwd: checkout, list: 'release', fields: { task: 'tag', status: 'done' } });
    const response = await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'todo' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe([
      `Saved to "release" in ${project}. Still open in it:`,
      '- release: version=13.25.2, blocked_on=npm token, updated 1 minute ago',
      '  - [todo] publish, updated 1 minute ago',
    ].join('\n'));
    expect(store.getWorkStateEntries([project]).map(entry => entry.fields)).toEqual([
      { version: '13.25.2', blocked_on: 'npm token' },
      { task: 'tag', status: 'done' },
      { task: 'publish', status: 'todo' },
    ]);
  });

  it('says when a write leaves nothing open in the list', async () => {
    await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'doing' } });
    const response = await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'done' } });

    expect(await response.text()).toBe(`Saved to "release" in ${project}. Nothing in it is open now.`);
  });

  it('keeps the answer to a write within the SessionStart section limit', async () => {
    for (let tableNumber = 0; tableNumber < 80; tableNumber++) {
      store.appendWorkStateEntry({ project, listName: 'migration', fields: { task: `table-${tableNumber}`, status: 'todo', note: 'x'.repeat(60) } });
    }

    const answer = await (await write({ cwd: checkout, list: 'migration', fields: { owner: 'agent' } })).text();

    expect(answer.length).toBeLessThanOrEqual(WORK_STATE_SECTION_CHARACTER_LIMIT);
    expect(answer).toStartWith(`Saved to "migration" in ${project}. Still open in it:\n- migration: owner=agent`);
    expect(answer).toMatch(/\n- \.\.\.\d+ more lines; read them with work_state_read$/);
  });

  it('refuses an entry it cannot store or show, and saves nothing', async () => {
    const refused = [
      { cwd: checkout, list: 'release', fields: {} },
      { cwd: checkout, list: 'release', fields: { note: { nested: true } } },
      { cwd: checkout, list: 'release', fields: { note: 'x'.repeat(MAX_WORK_STATE_FIELDS_JSON_CHARS) } },
      { cwd: checkout, list: '  ', fields: { task: 'publish' } },
      { list: 'release', fields: { task: 'publish' } },
    ];

    for (const body of refused) {
      const response = await write(body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    const emptyFields = await (await write(refused[0])).json() as { issues: Array<{ message: string }> };
    expect(emptyFields.issues.map(issue => issue.message)).toContain('fields must set at least one key');
    expect(store.getWorkStateEntries([project])).toEqual([]);
  });

  it('does not save for a project the user excluded', async () => {
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = basename(checkout);

    const response = await write({ cwd: checkout, list: 'release', fields: { task: 'publish' } });

    expect(await response.text()).toBe('Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).');
    expect(store.getWorkStateEntries([project])).toEqual([]);
  });

  it('reads what is open across lists, or one list with its closed items', async () => {
    await write({ cwd: checkout, list: 'release', fields: { version: '13.25.3' } });
    await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'todo' } });
    await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'dropped', reason: 'superseded' } });
    await write({ cwd: checkout, list: 'todo', fields: { task: 'update-docs', status: 'doing' } });

    expect(await (await read({ cwd: checkout })).text()).toBe([
      '- todo',
      '  - [doing] update-docs, updated 1 minute ago',
      '- release: version=13.25.3, updated 1 minute ago',
    ].join('\n'));
    expect(await (await read({ cwd: checkout, list: 'release', includeClosed: 'true' })).text()).toBe([
      '- release: version=13.25.3, updated 1 minute ago',
      '  - [dropped] publish (reason=superseded), updated 1 minute ago',
    ].join('\n'));
  });

  it('keeps same-name tasks and list state distinct across adopted projects', async () => {
    const oldProject = 'adopted-project';
    const sessionId = store.createSDKSession('adopted-host', oldProject, 'prompt');
    store.updateMemorySessionId(sessionId, 'adopted-observer');
    const observation = store.storeObservation('adopted-observer', oldProject, { type: 'discovery', title: 'Adopted worktree', subtitle: null, narrative: 'Fact', facts: [], concepts: [], files_read: [], files_modified: [] });
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run(project, observation.id);
    store.appendWorkStateEntry({ project, listName: 'release', fields: { task: 'ship', status: 'todo', owner: 'active' } });
    store.appendWorkStateEntry({ project: oldProject, listName: 'release', fields: { task: 'ship', status: 'done', owner: 'adopted' } });
    store.appendWorkStateEntry({ project: oldProject, listName: 'release', fields: { task: 'pack', status: 'doing' } });
    const entries = store.getWorkStateEntries([project]);
    const context = buildWorkStateContextSection(entries, Date.now());
    const response = await (await read({ cwd: checkout, list: 'release' })).text();
    for (const text of [context, response]) {
      expect(text).toContain('[todo] ship (owner=active)');
      expect(text).toContain('[doing] pack');
      expect(text).not.toContain('[done] ship');
      expect(text).toContain(`release [${project}]`);
      expect(text).toContain(`release [${oldProject}]`);
    }
    const closed = await (await read({ cwd: checkout, list: 'release', includeClosed: 'true' })).text();
    expect(closed).toContain('[todo] ship (owner=active)');
    expect(closed).toContain('[done] ship (owner=adopted)');
  });

  it('closes the same checkout task after its configured project key changes', async () => {
    await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'todo' } });
    process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS = JSON.stringify([{ name: 'configured-project', patterns: [checkout] }]);
    const keys = getProjectContext(checkout).allProjects;
    expect(keys).toContain(project);
    expect(keys).toContain('configured-project');
    const completed = await write({ cwd: checkout, list: 'release', fields: { task: 'publish', status: 'done' } });
    expect(await completed.text()).toContain('Nothing in it is open now.');
    const response = await (await read({ cwd: checkout, list: 'release' })).text();
    const context = await (await fetch(`http://127.0.0.1:${port}/api/context/inject?${new URLSearchParams({ projects: keys.join(',') })}`)).text();
    for (const text of [response, context]) expect(text).not.toContain('[todo] publish');
    const closed = await (await read({ cwd: checkout, list: 'release', includeClosed: 'true' })).text();
    expect(closed).toContain('[done] publish');
    expect(closed).not.toContain('[todo] publish');
  });

  it('says when nothing is open, and requires a cwd', async () => {
    expect(await (await read({ cwd: checkout })).text())
      .toBe(`Nothing open for ${project}. Pass includeClosed to see closed items.`);
    expect((await read({})).status).toBe(400);
  });
});


describe('literal primitive field keys', () => {
  it('continues to reject object values, arrays and empty keys', async () => {
    for (const fields of [JSON.parse('{"__proto__":{"polluted":true}}'), [], { '': 'invalid' }]) {
      const response = await write({ cwd: checkout, list: 'config', fields });
      expect(response.status).toBe(400);
    }
    expect(store.getWorkStateEntries([project])).toEqual([]);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('preserves prototype-named state keys through HTTP writes and reads', async () => {
    const fields = JSON.parse('{"__proto__":"literal state","constructor":"ordinary"}');
    const response = await write({ cwd: checkout, list: 'config', fields });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('__proto__=literal state');
    const stored = store.getWorkStateEntries([project], 'config')[0];
    expect(Object.hasOwn(stored.fields, '__proto__')).toBe(true);
    const readResponse = await read({ cwd: checkout, list: 'config' });
    expect(await readResponse.text()).toContain('__proto__=literal state');
    expect(Object.getPrototypeOf(stored.fields)).toBe(Object.prototype);
  });
});

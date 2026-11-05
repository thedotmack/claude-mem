import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';
import { buildWorkStateContextSection, renderWorkStateLines } from '../../../src/services/context/sections/WorkStateRenderer.js';
import { WorkStateRoutes } from '../../../src/services/worker/http/routes/WorkStateRoutes.js';
import { getProjectContext } from '../../../src/utils/project-name.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
test('all generic readers exclude current and future internal records, even malformed fields', () => {
  const db = new Database(':memory:'); const store = new SessionStore(db); cleanup.push(() => db.close());
  store.appendWorkStateEntry({ project: 'repo', listName: 'normal', fields: { task: 'Visible work', status: 'doing' } });
  store.appendWorkStateEntry({ project: 'repo', listName: '__my_work_v1:entry', fields: { task: 'Internal', status: 'doing' } });
  store.appendWorkStateEntry({ project: 'repo', listName: '__my_work_v2:entry', fields: { task: 'Future internal' } });
  db.query("UPDATE work_state_entries SET fields='not json' WHERE list_name='__my_work_v2:entry'").run();
  const raw = db.query('SELECT * FROM work_state_entries').all() as any[];
  const parsed = raw.map(row => ({ ...row, fields: row.fields === 'not json' ? row.fields : JSON.parse(row.fields) }));
  expect(store.getWorkStateEntries(['repo']).map(entry => entry.list_name)).toEqual(['normal']);
  expect(store.getWorkStateEntries(['repo'], '__my_work_v1:entry')).toEqual([]);
  expect(renderWorkStateLines(parsed, Date.now(), true).join('\n')).toContain('Visible work');
  expect(renderWorkStateLines(parsed, Date.now(), true).join('\n')).not.toContain('Internal');
  expect(buildWorkStateContextSection(parsed, Date.now())).not.toContain('__my_work');
  const state = reduceWorkState(parsed);
  expect(state.entryCount).toBe(1);
  expect(state.summary).toMatchObject({ lists: 1, tasks: 1, doing: 1 });
});

test('the public write route refuses reserved current and future lists without appending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-record-routes-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(':memory:'); cleanup.push(() => store.close());
  const app = express(); app.use(express.json());
  new WorkStateRoutes({ getSessionStore: () => store, getCloudSync: () => null } as any).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  for (const list of ['__my_work_v1:entry', '__my_work_v2:commit']) {
    const result = await fetch(`http://127.0.0.1:${port}/api/work-state/entries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: dir, list, fields: { task: 'Injected' } }) });
    expect(result.status).toBe(400);
  }
  expect(store.getWorkStateEntries(getProjectContext(dir).allProjects)).toEqual([]);
  expect(store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get()).toEqual({ count: 0 });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_WORK_STATE_FIELDS_JSON_CHARS,
  WorkStateRoutes,
} from '../../src/services/worker/http/routes/WorkStateRoutes.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getProjectContext } from '../../src/utils/project-name.js';
import { isSharedWorkList } from '../../src/services/work-view/shared-records.mjs';
import { isWorkStateFields } from '../../src/shared/work-state-fields.js';
import {
  parseWorkStateWriteArgs,
  WORK_STATE_WRITE_ARGS_ERROR,
  type ParsedWorkStateWrite,
} from '../../src/shared/work-state-batch.js';

/** Mirror the opt-in handler: parse fully, then POST one entry per parsed item. */
async function writeBatch(
  port: number,
  checkout: string,
  list: string,
  items: unknown[],
): Promise<ParsedWorkStateWrite> {
  const parsed = parseWorkStateWriteArgs({ list, items });
  if (parsed.kind === 'batch') {
    for (const fields of parsed.items) {
      await fetch(`http://127.0.0.1:${port}/api/work-state/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: checkout, list, fields }),
      });
    }
  }
  return parsed;
}

describe('isWorkStateFields — one predicate for the worker and the grouped-write helper', () => {
  it('accepts non-empty scalar maps and refuses every shape the worker cannot store', () => {
    expect(isWorkStateFields({ task: 'ok', status: 'todo', count: 1, ratio: 0.5, done: false, note: null })).toBe(true);
    expect(isWorkStateFields({})).toBe(false);
    expect(isWorkStateFields([])).toBe(false);
    expect(isWorkStateFields(null)).toBe(false);
    expect(isWorkStateFields({ '': 'value' })).toBe(false);
    expect(isWorkStateFields({ note: { nested: true } })).toBe(false);
    expect(isWorkStateFields({ count: Number.NaN })).toBe(false);
    expect(isWorkStateFields({ count: Infinity })).toBe(false);
    expect(isWorkStateFields({ count: 9007199254740993 })).toBe(false);
    expect(isWorkStateFields({ note: 'x'.repeat(MAX_WORK_STATE_FIELDS_JSON_CHARS) })).toBe(false);
  });
});

describe('parseWorkStateWriteArgs', () => {
  it('keeps the single form and groups a valid batch', () => {
    expect(parseWorkStateWriteArgs({ list: 'release', fields: { task: 'a' } }))
      .toEqual({ kind: 'single', fields: { task: 'a' } });
    expect(parseWorkStateWriteArgs({ list: 'release', items: [{ task: 'a' }, { task: 'b' }] }))
      .toEqual({ kind: 'batch', items: [{ task: 'a' }, { task: 'b' }] });
  });

  it.each([
    ['neither fields nor items', { list: 'release' }],
    ['both fields and items', { list: 'release', fields: { task: 'a' }, items: [{ task: 'b' }] }],
    ['empty items', { list: 'release', items: [] }],
    ['too many items', { list: 'release', items: Array.from({ length: 26 }, () => ({ task: 'x' })) }],
    ['blank task', { list: 'release', items: [{ task: '' }] }],
    ['nested value', { list: 'release', items: [{ note: { nested: true } }] }],
    ['oversized JSON', { list: 'release', items: [{ note: 'x'.repeat(MAX_WORK_STATE_FIELDS_JSON_CHARS) }] }],
    ['unsafe integer', { list: 'release', items: [{ status: 9007199254740993 }] }],
    ['non-array items', { list: 'release', items: { task: 'a' } }],
  ])('refuses %s with the fixed message', (_label, args) => {
    expect(parseWorkStateWriteArgs(args)).toEqual({ kind: 'error', message: WORK_STATE_WRITE_ARGS_ERROR });
  });
});

describe('grouped writes have worker parity before the first POST', () => {
  let server: Server | undefined;
  let port = 0;
  let store: SessionStore;
  let checkout: string;
  let posts: unknown[];

  beforeEach(async () => {
    store = new SessionStore(':memory:');
    checkout = mkdtempSync(join(tmpdir(), 'work-state-batch-'));
    posts = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { if (req.method === 'POST') posts.push(req.body); next(); });
    const dbManager = { getSessionStore: () => store, getCloudSync: () => ({ notify: () => {} }) };
    new WorkStateRoutes(dbManager as any, join(checkout, 'guard.json')).setupRoutes(app);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
      server = undefined;
    });
    store.close();
    rmSync(checkout, { recursive: true, force: true });
  });

  const rowCount = () => (store.db.prepare('SELECT COUNT(*) AS n FROM work_state_entries').get() as { n: number }).n;

  it('posts nothing when a valid entry is followed by an unsafe integer', async () => {
    expect(isSharedWorkList('release')).toBe(false);
    const parsed = await writeBatch(port, checkout, 'release', [{ task: 'ok' }, { status: 9007199254740993 }]);

    expect(parsed).toEqual({ kind: 'error', message: WORK_STATE_WRITE_ARGS_ERROR });
    expect(posts).toEqual([]);
    expect(rowCount()).toBe(0);

    // The worker independently refuses the same integer: parity, not a looser local rule.
    const refused = await fetch(`http://127.0.0.1:${port}/api/work-state/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: checkout, list: 'release', fields: { status: 9007199254740993 } }),
    });
    expect(refused.status).toBe(400);
    expect(rowCount()).toBe(0);
  });

  it('refuses a reserved list and an unkind owner-goals row before any POST', async () => {
    expect((await writeBatch(port, checkout, '__my_work_v1:entry', [{ task: 'ok' }])).kind).toBe('error');
    expect((await writeBatch(port, checkout, 'owner-goals', [{ task: 'Ask: draft', status: 'todo' }])).kind).toBe('error');
    expect(posts).toEqual([]);
    expect(rowCount()).toBe(0);
  });

  it('accepts a whole batch the worker accepts, including kinded owner-goals rows', async () => {
    const list = 'owner-goals/2026-11';
    expect(getProjectContext(checkout).primary).toBeTruthy();
    expect((await writeBatch(port, checkout, list, [
      { task: 'Focus: batching', status: 'todo', goal_kind: 'focus-area' },
      { task: 'Ask: review', status: 'todo', goal_kind: 'ask' },
    ])).kind).toBe('batch');

    expect(posts).toHaveLength(2);
    expect(rowCount()).toBe(2);
  });
});

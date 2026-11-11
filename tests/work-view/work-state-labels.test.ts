import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { buildAgentView } from '../../src/services/work-view/agent-view.mjs';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { reduceWorkState } from '../../src/services/work-view/work-state-reduce.mjs';
import {
  appliedLabel, judgedStatusFor, JUDGED_WORK_STATES, LABEL_THRESHOLD, labelOpenWorkState, readWorkStateLabels,
} from '../../src/services/work-view/work-state-labels.mjs';
import { scratchDir } from '../helpers/scratch-dir.js';

const DAY = 86400000, NOW = 100 * DAY;

function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  return db;
}
const write = (db: Database, list: string, fields: Record<string, unknown>, at = NOW - 10 * DAY) =>
  Number(db.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)').run('repo', list, JSON.stringify(fields), at).lastInsertRowid);

type Call = { state: any; questions: any };
/** A Jev stand-in that records every question and answers each asked question from the script. No network. */
function fakeJev(script: (question: string, call: Call) => { choice: string; p: number } | Error) {
  const calls: Call[] = [];
  const client = {
    name: 'jev' as const, url: 'https://cmem.ai/api/inference/v1/decisions', model: 'typesafe/jev-1.14',
    async decide(state: any, questions: any) {
      const call = { state, questions };
      calls.push(call);
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions)) {
        const answer = script(id, call);
        if (answer instanceof Error) throw answer;
        answers[id] = { type: 'choice', choice: answer.choice, probabilities: { [answer.choice]: answer.p } };
      }
      return { answers, model: 'typesafe/jev-1.14-test' };
    },
  };
  return { calls, client };
}
/** The option id Jev's question gave a note field (f0, f1, ...). */
const fieldOption = (call: Call, question: string, field: string) =>
  Object.entries(call.questions[question].criteria).find(([, words]) => words === `\`item.notes.${field}\``)?.[0] ?? 'none';

describe('Jev work-state labels', () => {
  it('asks once per open item version, never closed items or system lists, and keeps only current versions', async () => {
    const dir = scratchDir('work-state-labels');
    try {
      const db = database();
      const shipped = write(db, 'release', { task: 'Ship 1.2', status: 'doing', left: 'Merged; nothing left', work_product: 'https://github.com/o/r/pull/1' });
      write(db, 'release', { task: 'Old step', status: 'done' });
      write(db, 'owner-goals', { task: 'Focus area: Cards', status: 'todo' });
      write(db, 'my-rules', { task: 'rule:1', status: 'todo' });
      const listState = write(db, 'release', { phase: 'Shipping' });
      const { calls, client } = fakeJev((question, call) => question === 'state' ? { choice: call.state.item.name ? 'finished' : 'working', p: 0.9 }
        : question === 'next' ? { choice: fieldOption(call, 'next', 'left'), p: 0.85 } : { choice: fieldOption(call, 'result', 'work_product'), p: 0.95 });

      const first = await labelOpenWorkState({ dir, database: db, client, now: () => NOW, wait: async () => {} });
      expect(first).toEqual({ open: 2, labeled: 2, removed: 0, notReached: 0, failed: null, serviceFailure: null });
      expect(calls.map((call) => call.state.item.name ?? '(list)')).toEqual(['Ship 1.2', '(list)']);
      expect(calls[0].state.item).toMatchObject({ list: 'release', recorded_status: 'doing', days_since_last_update: 10, notes: { left: 'Merged; nothing left', work_product: 'https://github.com/o/r/pull/1' } });
      expect(Object.keys(calls[0].questions.state.criteria)).toEqual(Object.keys(JUDGED_WORK_STATES));
      const labels = readWorkStateLabels(dir).labels;
      expect(labels[shipped]).toMatchObject({ state: 'finished', stateP: 0.9, nextField: 'left', nextP: 0.85, resultField: 'work_product', resultP: 0.95, model: 'typesafe/jev-1.14-test' });
      expect(labels[listState]).toMatchObject({ state: 'working', nextField: null, resultField: null });

      expect(await labelOpenWorkState({ dir, database: db, client, now: () => NOW, wait: async () => {} })).toMatchObject({ labeled: 0, removed: 0 });
      expect(calls).toHaveLength(2);

      // A new write is a new version: it is asked, and the old version's label goes.
      const rewritten = write(db, 'release', { task: 'Ship 1.2', status: 'doing', left: 'Waiting on CI' }, NOW - DAY);
      expect(await labelOpenWorkState({ dir, database: db, client, now: () => NOW, wait: async () => {} })).toMatchObject({ labeled: 1, removed: 1 });
      expect(Object.keys(readWorkStateLabels(dir).labels).sort()).toEqual([String(listState), String(rewritten)].sort());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stops at the first failed call, records it for that version only, and asks the rest at the next check', async () => {
    const dir = scratchDir('work-state-labels');
    try {
      const db = database();
      const broken = write(db, 'a', { task: 'One', status: 'doing', note: 'x' });
      const later = write(db, 'a', { task: 'Two', status: 'doing', note: 'y' });
      let failing = true;
      const { calls, client } = fakeJev((question) => failing && question === 'state' ? new Error('Jev answered 400 bad_request: question too large') : { choice: question === 'state' ? 'working' : 'none', p: 0.9 });
      expect(await labelOpenWorkState({ dir, database: db, client, now: () => NOW, wait: async () => {} })).toEqual({
        open: 2, labeled: 0, removed: 0, notReached: 1, failed: { entryId: broken, at: new Date(NOW).toISOString(), error: 'Jev answered 400 bad_request: question too large' }, serviceFailure: null,
      });
      failing = false;
      expect(await labelOpenWorkState({ dir, database: db, client, now: () => NOW, wait: async () => {} })).toMatchObject({ labeled: 1, notReached: 0, failed: null });
      // The failed version is not sent again; the one the first run never reached is.
      expect(calls.map((call) => call.state.item.name)).toEqual(['One', 'Two']);
      const file = readWorkStateLabels(dir);
      expect(Object.keys(file.labels)).toEqual([String(later)]);
      expect(Object.keys(file.failures)).toEqual([String(broken)]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a 429 or a 5xx stops the run without marking the item failed, and calls are paced one interval apart', async () => {
    const dir = scratchDir('work-state-labels');
    try {
      const db = database();
      write(db, 'a', { task: 'One', status: 'doing', note: 'x' });
      const limited = write(db, 'a', { task: 'Two', status: 'doing', note: 'y' });
      write(db, 'a', { task: 'Three', status: 'doing', note: 'z' });
      let limit = true;
      const waits: number[] = [];
      const { calls, client } = fakeJev((question, call) => limit && call.state.item.name === 'Two' ? new Error('Jev answered 429 rate_limited: Too many observer requests in the last minute.') : { choice: question === 'state' ? 'working' : 'none', p: 0.9 });
      const run = () => labelOpenWorkState({ dir, database: db, client, now: () => NOW, intervalMs: 1000, wait: async (ms) => { waits.push(ms); } });
      expect(await run()).toMatchObject({ labeled: 1, notReached: 2, failed: null, serviceFailure: expect.stringContaining('429') });
      expect(waits).toEqual([1000]);
      expect(readWorkStateLabels(dir).failures).toEqual({});
      limit = false;
      expect(await run()).toMatchObject({ labeled: 2, notReached: 0, serviceFailure: null });
      expect(calls.map((call) => call.state.item.name)).toEqual(['One', 'Two', 'Two', 'Three']);
      expect(readWorkStateLabels(dir).labels[limited]).toMatchObject({ state: 'working' });
      const outage = write(db, 'a', { task: 'Four', status: 'doing', note: 'w' });
      const down = fakeJev(() => new Error('Jev answered 500: A server error has occurred'));
      expect(await labelOpenWorkState({ dir, database: db, client: down.client, now: () => NOW, wait: async () => {} })).toMatchObject({ labeled: 0, notReached: 1, failed: null, serviceFailure: expect.stringContaining('500') });
      expect(readWorkStateLabels(dir).failures[outage]).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('asks only the state when an item has more note fields than one choice takes, and says so', async () => {
    const dir = scratchDir('work-state-labels');
    try {
      const db = database();
      const wide = write(db, 'a', { task: 'Wide', status: 'doing', ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`note_${index}`, 'x'])) });
      const { calls, client } = fakeJev(() => ({ choice: 'working', p: 0.9 }));
      await labelOpenWorkState({ dir, database: db, client, now: () => NOW, wait: async () => {} });
      expect(Object.keys(calls[0].questions)).toEqual(['state']);
      expect(readWorkStateLabels(dir).labels[wide]).toMatchObject({ nextField: null, resultField: null, fieldsNotAsked: '20 note fields; one choice takes at most 19' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('replaces only statuses a quiet agent leaves behind, and a todo only with finished or abandoned', () => {
    expect(judgedStatusFor('doing', 'finished')).toBe('needs-review');
    expect(judgedStatusFor('doing', 'waiting_on_person')).toBe('needs-you');
    expect(judgedStatusFor('doing', 'working')).toBeNull();
    expect(judgedStatusFor('unknown', 'working')).toBe('doing');
    expect(judgedStatusFor('open', 'abandoned')).toBe('dropped');
    expect(judgedStatusFor('todo', 'waiting_on_person')).toBeNull();
    expect(judgedStatusFor('todo', 'finished')).toBe('needs-review');
    expect(judgedStatusFor('needs-review', 'working')).toBeNull();
    expect(judgedStatusFor('blocked', 'finished')).toBeNull();
  });

  it('applies a label only to the version it judged and only at the threshold', () => {
    const label = { at: '', model: 'm', state: 'finished' as const, stateP: LABEL_THRESHOLD, nextField: 'left', nextP: LABEL_THRESHOLD - 0.01, resultField: 'work_product', resultP: 0.99 };
    expect(appliedLabel({ latestEntryId: 7, status: 'doing' }, { 7: label })).toEqual({ judgedStatus: 'needs-review', nextField: null, resultField: 'work_product', label });
    expect(appliedLabel({ latestEntryId: 8, status: 'doing' }, { 7: label })).toEqual({ judgedStatus: null, nextField: null, resultField: null, label: null });
    expect(appliedLabel({ latestEntryId: 7, status: 'doing' }, { 7: { ...label, stateP: LABEL_THRESHOLD - 0.01 } }).judgedStatus).toBeNull();
  });

  it('My Work shows the judged status and the next step and result from the fields Jev named', () => {
    const db = database();
    const entryId = write(db, 'release', { task: 'Ship 1.2', status: 'doing', left: 'Nothing left', work_product: 'https://github.com/o/r/pull/1' });
    const rows = db.prepare('SELECT * FROM work_state_entries').all();
    const state = reduceWorkState(rows as any, { currentProject: 'repo', currentProjectScope: ['repo'] });
    const labels = { [entryId]: { at: new Date(NOW).toISOString(), model: 'typesafe/jev-1.14-test', state: 'finished', stateP: 0.9, nextField: 'left', nextP: 0.9, resultField: 'work_product', resultP: 0.9 } };
    const item = buildAgentView(state, {}, { now: NOW, workStateLabels: { schemaVersion: 1, labels, failures: {} } }).agents.flatMap((agent: any) => agent.work).find((work: any) => work.title === 'Ship 1.2');
    expect(item).toMatchObject({
      status: 'doing', judgedStatus: 'needs-review', judgment: { state: 'finished', probability: 0.9, model: 'typesafe/jev-1.14-test' },
      nextStep: { text: 'Nothing left', field: 'left', pickedBy: 'jev' }, outcome: { text: 'https://github.com/o/r/pull/1', field: 'work_product', pickedBy: 'jev' },
    });
    const unlabeled = buildAgentView(state, {}, { now: NOW }).agents.flatMap((agent: any) => agent.work).find((work: any) => work.title === 'Ship 1.2');
    expect(unlabeled).toMatchObject({ judgedStatus: null, judgment: null, nextStep: null, outcome: null });
  });

  it('the ten-minute check labels beside the agent run, one labeling run at a time, and not while refresh is off', async () => {
    const dir = scratchDir('work-state-labels');
    try {
      let enabled = false, runs = 0, release = () => {};
      const worker = new AutoRefreshWorker({
        localDeviceId: () => '', dir, enabled: () => enabled,
        openDatabase: () => ({ prepare: () => ({ all: () => [], get: () => undefined }), close() {} }) as any,
        runJob: async () => ({ state: 'ok', agent: 'claude-code', result: null, error: null }),
        labelWorkState: () => { runs++; return new Promise((resolve) => { release = () => resolve({ open: 0, labeled: 0, removed: 0, notReached: 0, failed: null, serviceFailure: null }); }); },
      });
      expect(await worker.check()).toBe('disabled');
      expect(runs).toBe(0);
      enabled = true;
      await worker.check().catch(() => {});
      await worker.check().catch(() => {});
      await Promise.resolve();
      expect(runs).toBe(1);
      const running = worker.labelInBackground();
      release();
      await running;
      expect(worker.labelInBackground()).not.toBeNull();
      await Promise.resolve();
      expect(runs).toBe(2);
      release();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


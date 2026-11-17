import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRefreshTask } from '../../src/services/work-view/refresh-task.js';
import { readLedger, runCli } from '../../src/services/work-view/request-groups.mjs';
import { everyRequestInOther, focusWriter } from '../helpers/fake-focus-writer.js';

const NOW = Date.parse('2026-11-16T10:00:00.000Z');
const INPUT_BYTES = 256 * 1024;
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');

function fixture(count = 32) {
  const dir = mkdtempSync(join(tmpdir(), 'story-batches-'));
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  let now = NOW;
  const cli = (args: string[], input?: unknown) => {
    const path = join(dir, 'fixture-input.json');
    if (input !== undefined) writeFileSync(path, JSON.stringify(input));
    let result: any;
    runCli(input === undefined ? args : [...args, path], { dir, database, now, localDeviceId: '', print: value => { result = value; } });
    return result;
  };
  const groups = Array.from({ length: count }, (_, i) => {
    const session = `request-${i}`;
    database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(i + 1, 'claude', session, `memory-${i}`, 'repo', `Ship request ${i}`, NOW - 1000);
    database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(i + 1, 1, `Ship request ${i}`, NOW - 1000);
    return { title: `Request ${i}`, conversations: [JSON.stringify(['conversation', 'claude', session])] };
  });
  cli(['apply'], { groups });
  const ids = Object.keys(readLedger(dir).groups.groups);
  for (const groupId of ids) {
    const show = cli(['show', groupId]);
    cli(['record-progress'], { groupId, state: 'in-progress', percent: 40, reviewBasis: show.reviewBasis,
      summary: 'Verified work is in progress.', narrative: '细'.repeat(1100), startedAt: new Date(NOW - 1000).toISOString(),
      milestones: Array.from({ length: 12 }, () => ({ text: '验'.repeat(180) })),
      preferences: Array.from({ length: 10 }, () => ({ kind: 'directive', preference: '规'.repeat(180), quote: '据'.repeat(280) })),
    });
  }
  const task = () => buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: false, unplaced: count, otherChanged: false, needed: true },
    reason: 'manual', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, now: () => now,
    openDatabase: () => ({ prepare: database.prepare.bind(database), close() {} }), saveFocus: focusWriter(database).save });
  return { dir, ids: cli(['story-input']).reviews.map((review: any) => review.groupId), cli, task,
    advance() { now += 1000; }, close() { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function storyFile(prompt: string) {
  const path = /The `story-input` output is in (.+?\.json)/.exec(prompt)![1];
  const text = readFileSync(path, 'utf8');
  return { text, input: JSON.parse(text) };
}

describe('bounded story inputs', () => {
  it.each(['api', 'codex'] as const)('processes every large review once through bounded %s questions', async agent => {
    const f = fixture();
    try {
      expect(Buffer.byteLength(JSON.stringify(f.cli(['story-input'])))).toBeGreaterThan(2 * INPUT_BYTES);
      const seen: string[] = [];
      let batches = 0;
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        expect(prompt).toContain('Do only section 4');
        const { text, input } = storyFile(prompt);
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
        if (agent === 'api') expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(320 * 1024);
        expect(input.update).toBe(batches > 0);
        if (batches) expect(input.previousStory.narrative).toBe(seen.join(', '));
        // A partial story must not acknowledge the reviews still waiting in later batches.
        expect(readLedger(f.dir).story).toBeNull();
        seen.push(...input.reviews.map((review: any) => review.groupId));
        batches++;
        return JSON.stringify({ narrative: seen.join(', '), preferences: [] });
      }, agent);
      expect(batches).toBeGreaterThan(1);
      expect(seen).toEqual(f.ids);
      expect(readLedger(f.dir).story.narrative).toBe(seen.join(', '));
      expect(f.cli(['story-input']).reviews).toEqual([]);
    } finally { f.close(); }
  });

  it('keeps the saved story and all pending facts when a later batch fails', async () => {
    const f = fixture();
    const previous = { narrative: 'Existing verified story.', preferences: [], writtenAt: new Date(NOW - 2000).toISOString() };
    writeFileSync(join(f.dir, 'story.json'), JSON.stringify(previous));
    try {
      let calls = 0;
      const result = f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (++calls === 2) throw new Error('Provider stopped during the second story batch');
        return JSON.stringify({ narrative: 'Checked draft of the first batch.', preferences: [] });
      }, 'api');
      await expect(result).rejects.toThrow('Provider stopped during the second story batch');
      expect(readLedger(f.dir).story).toEqual(previous);
      expect(f.cli(['story-input']).reviews.map((review: any) => review.groupId)).toEqual(f.ids);
    } finally { f.close(); }
  });

  it('leaves reviews changed during the story run due for the next refresh', async () => {
    const f = fixture(1);
    try {
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        f.advance();
        const groupId = f.ids[0];
        const review = readLedger(f.dir).progress[groupId];
        f.cli(['record-progress'], { ...review, percent: 60, reviewBasis: f.cli(['show', groupId]).reviewBasis });
        return JSON.stringify({ narrative: 'The snapshot showed 40 percent.', preferences: [] });
      }, 'api');
      expect(f.cli(['story-input']).reviews.map((review: any) => review.percent)).toEqual([60]);
    } finally { f.close(); }
  });

  it('keeps preference evidence from separate narrative batches together without counting drafts again', async () => {
    const f = fixture();
    const savedPreference = { preference: 'Keep changes focused.', kind: 'directive', supportCount: 3,
      quotes: [{ quote: 'One concern per change.', at: null }] };
    writeFileSync(join(f.dir, 'story.json'), JSON.stringify({ narrative: 'Existing story.', preferences: [savedPreference],
      writtenAt: new Date(NOW - 2000).toISOString() }));
    const first = { kind: 'directive', preference: 'Run tests before committing.', quote: 'Please run the tests before you commit.', at: null };
    const last = { kind: 'correction', preference: 'Validate changes before committing.', quote: 'Before any commit, run the tests.', at: null };
    try {
      for (const groupId of f.ids) {
        const preferences = groupId === f.ids[0] ? [first, first] : groupId === f.ids.at(-1) ? [last] : [];
        f.cli(['record-progress'], { ...readLedger(f.dir).progress[groupId], preferences,
          reviewBasis: f.cli(['show', groupId]).reviewBasis });
      }
      let calls = 0;
      const seen: string[] = [];
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const { text, input } = storyFile(prompt);
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
        expect(input.preferenceEvidence).toEqual({
          values: [first, last],
          requests: [{ groupId: f.ids[0], preferences: [0] }, { groupId: f.ids.at(-1), preferences: [1] }],
        });
        expect(input.previousStory.preferences).toEqual([savedPreference]);
        expect(input.reviews.every((review: any) => !Object.hasOwn(review, 'preferences'))).toBe(true);
        expect(prompt).toContain('preferenceEvidence');
        seen.push(...input.reviews.map((review: any) => review.groupId));
        calls++;
        return JSON.stringify({ narrative: seen.join(', '), preferences: [savedPreference, {
          preference: first.preference, kind: 'directive', supportCount: 2,
          quotes: [{ quote: first.quote, at: null }, { quote: last.quote, at: null }],
        }] });
      }, 'api');
      expect(calls).toBeGreaterThan(1);
      expect(seen).toEqual(f.ids);
      expect(readLedger(f.dir).story.preferences[1].supportCount).toBe(2);
      expect(readLedger(f.dir).story.preferences[1].quotes.map((quote: any) => quote.quote)).toEqual([first.quote, last.quote]);
    } finally { f.close(); }
  });

  it('does not discard shared preference evidence when the complete index cannot fit', async () => {
    const f = fixture();
    try {
      for (const groupId of f.ids) {
        f.cli(['record-progress'], { ...readLedger(f.dir).progress[groupId],
          preferences: Array.from({ length: 10 }, (_, index) => ({ kind: 'directive',
            preference: `${groupId}-${index}-${'规'.repeat(150)}`, quote: '据'.repeat(280) })),
          reviewBasis: f.cli(['show', groupId]).reviewBasis });
      }
      let calls = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        calls++;
        return JSON.stringify({ narrative: 'Must not be requested.', preferences: [] });
      }, 'api')).rejects.toThrow('complete preference evidence');
      expect(calls).toBe(0);
      expect(readLedger(f.dir).story).toBeNull();
      expect(f.cli(['story-input']).reviews.map((review: any) => review.groupId)).toEqual(f.ids);
    } finally { f.close(); }
  });

  it('does not save a partial story when a later draft is refused twice', async () => {
    const f = fixture();
    try {
      let calls = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        return JSON.stringify({ narrative: ++calls === 1 ? 'Checked first draft.' : 'x'.repeat(12001), preferences: [] });
      }, 'api')).rejects.toThrow('narrative is 12001 characters');
      expect(calls).toBe(3);
      expect(readLedger(f.dir).story).toBeNull();
      expect(f.cli(['story-input']).reviews.map((review: any) => review.groupId)).toEqual(f.ids);
    } finally { f.close(); }
  });

  it('refuses an indivisible oversized review before asking the story model', async () => {
    const f = fixture(1);
    try {
      const groupId = f.ids[0];
      f.cli(['record-progress'], { ...readLedger(f.dir).progress[groupId], evidence: ['e'.repeat(INPUT_BYTES)],
        reviewBasis: f.cli(['show', groupId]).reviewBasis });
      let storyCalls = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        storyCalls++;
        return JSON.stringify({ narrative: 'Should not be asked.', preferences: [] });
      }, 'api')).rejects.toThrow('No story was saved and no review was skipped');
      expect(storyCalls).toBe(0);
      expect(readLedger(f.dir).story).toBeNull();
      expect(f.cli(['story-input']).reviews).toHaveLength(1);
    } finally { f.close(); }
  });
});

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRefreshTask } from '../../src/services/work-view/refresh-task.js';
import { boundedStoryPreferences, storyPreferenceEvidence } from '../../src/services/work-view/story-batches.js';
import { readLedger, runCli, storyInput } from '../../src/services/work-view/request-groups.mjs';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { readStoryCache, storyFingerprint, writeStoryCache } from '../../src/services/work-view/story-cache.js';
import { registerSharedFileWriter } from '../../src/services/work-view/shared-file-hooks.mjs';
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
  return { dir, database, ids: cli(['story-input']).reviews.map((review: any) => review.groupId), cli, task,
    advance() { now += 1000; }, close() { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function storyFile(prompt: string) {
  const path = /The `story-input` output is in (.+?\.json)/.exec(prompt)![1];
  const text = readFileSync(path, 'utf8');
  return { text, input: JSON.parse(text) };
}

function preferenceFile(prompt: string) {
  const path = /The `preference-input` output is in (.+?\.json)/.exec(prompt)![1];
  const text = readFileSync(path, 'utf8');
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
  expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(320 * 1024);
  return JSON.parse(text) as { values: Array<{ id: number; evidence: Record<string, any> }> };
}

function canonicalAnswer(input: { values: Array<{ id: number; evidence: Record<string, any> }> },
  target: (value: { id: number; evidence: Record<string, any> }) => string = value => value.evidence.preference) {
  return { assignments: input.values.map(value => ({ id: value.id,
    key: { action: 'apply', target: target(value), condition: '', polarity: 'require' } })) };
}

function largePreferences(f: ReturnType<typeof fixture>) {
  const first = { kind: 'directive', preference: 'Run tests before committing.', quote: 'Please run the tests before you commit.', at: null };
  const sameRequest = { kind: 'correction', preference: 'Verify the tests before each commit.', quote: 'Commit only after tests pass.', at: null };
  const last = { kind: 'correction', preference: 'Validate changes before committing.', quote: 'Before any commit, run the tests.', at: null };
  for (const groupId of f.ids) {
    const preferences = Array.from({ length: 10 }, (_, index) => ({ kind: 'directive',
      preference: `${groupId}-${index}-${'规'.repeat(150)}`, quote: '据'.repeat(280), at: null }));
    if (groupId === f.ids[0]) preferences.splice(0, 3, first, sameRequest, first);
    if (groupId === f.ids.at(-1)) preferences[9] = last;
    f.cli(['record-progress'], { ...readLedger(f.dir).progress[groupId], preferences,
      reviewBasis: f.cli(['show', groupId]).reviewBasis });
  }
  return { first, sameRequest, last };
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
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        f.advance();
        const groupId = f.ids[0];
        const review = readLedger(f.dir).progress[groupId];
        f.cli(['record-progress'], { ...review, percent: 60, reviewBasis: f.cli(['show', groupId]).reviewBasis });
        return JSON.stringify({ narrative: 'The snapshot showed 40 percent.', preferences: [] });
      }, 'api')).rejects.toThrow('review evidence, or local device changed');
      expect(readLedger(f.dir).story).toBeNull();
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
          requests: f.ids.map(groupId => ({ groupId, preferences: groupId === f.ids[0] ? [0] : groupId === f.ids.at(-1) ? [1] : [] })),
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

  it('processes preference-heavy backlogs without losing cross-page support or original evidence', async () => {
    const f = fixture();
    const savedPreference = { preference: 'Keep changes focused.', kind: 'directive', supportCount: 3,
      quotes: [{ quote: 'One concern per change.', at: null }] };
    const saved = { narrative: 'Existing verified story.', preferences: [savedPreference], writtenAt: new Date(NOW - 2000).toISOString() };
    writeFileSync(join(f.dir, 'story.json'), JSON.stringify(saved));
    try {
      const { first, sameRequest, last } = largePreferences(f);
      const original = f.cli(['story-input']).reviews.map((review: any) => review.preferences);
      const expected = new Set([JSON.stringify(savedPreference), ...original.flat().map((value: any) => JSON.stringify(value))]);
      expect(Buffer.byteLength(JSON.stringify([...expected]), 'utf8')).toBeGreaterThan(INPUT_BYTES);
      const evidenceSeen = new Set<string>(), reviewsSeen: string[] = [];
      let comparisons = 0;
      const pages = new Map<string, number>();
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        expect(readLedger(f.dir).story).toEqual(saved);
        if (prompt.includes('`preference-input`')) {
          const input = preferenceFile(prompt);
          comparisons++;
          for (const value of input.values) {
            const encoded = JSON.stringify(value.evidence);
            expect(expected.has(encoded)).toBe(true);
            evidenceSeen.add(encoded);
          }
          for (const value of input.values) pages.set(value.evidence.preference, comparisons);
          return JSON.stringify(canonicalAnswer(input, value => [first.preference, sameRequest.preference, last.preference].includes(value.evidence.preference)
            ? 'run tests before committing' : value.evidence.preference));
        }
        const { input, text } = storyFile(prompt);
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
        expect(input.preferenceEvidence).toBeUndefined();
        expect(input.previousStory?.preferences ?? []).toEqual([]);
        reviewsSeen.push(...input.reviews.map((review: any) => review.groupId));
        return JSON.stringify({ narrative: reviewsSeen.join(', '), preferences: [] });
      }, 'api');
      // 319 distinct new values plus one saved preference need five linear pages.
      expect(expected.size).toBe(320);
      expect(comparisons).toBe(5);
      expect(pages.get(first.preference)).not.toBe(pages.get(last.preference));
      expect(evidenceSeen).toEqual(expected);
      expect(reviewsSeen).toEqual(f.ids);
      expect(readLedger(f.dir).story.preferences).toEqual([savedPreference, {
        preference: first.preference, kind: first.kind, supportCount: 2,
        quotes: [{ quote: first.quote, at: null }, { quote: sameRequest.quote, at: null }, { quote: last.quote, at: null }],
      }]);
      expect(f.ids.map(groupId => readLedger(f.dir).progress[groupId].preferences)).toEqual(original);
      expect(f.cli(['story-input']).reviews).toEqual([]);
    } finally { f.close(); }
  });

  it('does not add saved support counts to requests that may already be counted', async () => {
    const f = fixture(2);
    const savedPreference = { preference: 'Keep changes focused.', kind: 'directive', supportCount: 3,
      quotes: [{ quote: 'One concern per change.', at: null }] };
    writeFileSync(join(f.dir, 'story.json'), JSON.stringify({ narrative: 'Existing story.', preferences: [savedPreference], writtenAt: new Date(NOW - 2000).toISOString() }));
    try {
      for (const groupId of f.ids) f.cli(['record-progress'], { ...readLedger(f.dir).progress[groupId],
        preferences: [{ kind: 'directive', preference: 'Make each change focused.', quote: `Keep ${groupId} to one concern.`, at: null }],
        reviewBasis: f.cli(['show', groupId]).reviewBasis });
      const input = f.cli(['story-input']);
      const { preferences, provenance } = await boundedStoryPreferences(input, storyPreferenceEvidence(input), async (comparison, validate) => {
        return validate(canonicalAnswer(comparison, () => 'keep changes focused'));
      });
      expect(provenance[0].legacySupportCount).toBe(3);
      expect(provenance[0].requestIds).toHaveLength(2);
      expect(preferences).toHaveLength(1);
      expect(preferences[0].preference).toBe(savedPreference.preference);
      expect(preferences[0].supportCount).toBe(3);
      expect(preferences[0].quotes.map((quote: any) => quote.quote)).toEqual([
        savedPreference.quotes[0].quote, ...f.ids.map(groupId => `Keep ${groupId} to one concern.`),
      ]);
    } finally { f.close(); }
  });

  it('retains transitive matches across three pages and counts each request once', async () => {
    const values = Array.from({ length: 257 }, (_, id) => ({ kind: 'directive',
      preference: `Preference ${id}`, quote: `Original quote ${id}`, at: null }));
    const requests = values.map((_, id) => ({ groupId: id === 0 || id === 128 ? 'same-request' : `request-${id}`, preferences: [id] }));
    let comparisons = 0;
    const { preferences } = await boundedStoryPreferences(storyInput(256, [], null), { values, requests }, async (input, validate) => {
      comparisons++;
      expect(Buffer.byteLength(JSON.stringify(input, null, 2), 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
      // The same three source members retain their equivalence across distant pages.
      return validate(canonicalAnswer(input, value => [0, 128, 256].includes(value.id) ? 'bridge preference' : value.evidence.preference));
    });
    expect(comparisons).toBe(5);
    expect(preferences).toEqual([{ preference: 'Preference 0', kind: 'directive', supportCount: 2,
      quotes: [0, 128, 256].map(id => ({ quote: `Original quote ${id}`, at: null })),
    }]);
  });

  it.each(['missing', 'duplicate', 'unknown'] as const)('refuses %s preference ids without saving or acknowledging the backlog', async invalid => {
    const f = fixture();
    try {
      largePreferences(f);
      let comparisons = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const input = preferenceFile(prompt);
        comparisons++;
        const ids = input.values.map(value => value.id);
        if (invalid === 'missing') ids.pop();
        if (invalid === 'duplicate') ids.push(ids[0]);
        if (invalid === 'unknown') ids[0] = 999_999;
        const answer = canonicalAnswer(input);
        return JSON.stringify({ assignments: ids.map(id => ({ id, key: answer.assignments[0].key })) });
      }, 'api')).rejects.toThrow('preference id');
      expect(comparisons).toBe(2);
      expect(readLedger(f.dir).story).toBeNull();
      expect(f.cli(['story-input']).reviews.map((review: any) => review.groupId)).toEqual(f.ids);
    } finally { f.close(); }
  });

  it('preserves the saved story and pending reviews when a later preference comparison fails', async () => {
    const f = fixture();
    const saved = { narrative: 'Existing verified story.', preferences: [], writtenAt: new Date(NOW - 2000).toISOString() };
    writeFileSync(join(f.dir, 'story.json'), JSON.stringify(saved));
    try {
      largePreferences(f);
      let comparisons = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const input = preferenceFile(prompt);
        if (++comparisons === 2) throw new Error('Provider stopped during preference comparison');
        return JSON.stringify(canonicalAnswer(input));
      }, 'api')).rejects.toThrow('Provider stopped during preference comparison');
      expect(comparisons).toBe(2);
      expect(readLedger(f.dir).story).toEqual(saved);
      expect(f.cli(['story-input']).reviews.map((review: any) => review.groupId)).toEqual(f.ids);
    } finally { f.close(); }
  });

  it('resumes checked preference pages and narrative drafts on a fresh task without replaying them', async () => {
    const f = fixture();
    try {
      largePreferences(f);
      let pages = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const input = preferenceFile(prompt);
        if (++pages === 3) throw new Error('Preference provider stopped');
        return JSON.stringify(canonicalAnswer(input));
      }, 'api')).rejects.toThrow('Preference provider stopped');
      const cachePath = join(f.dir, 'story-preferences', 'state.json');
      expect(Object.keys(JSON.parse(readFileSync(cachePath, 'utf8')).canonical)).toHaveLength(128);
      const priorReadAt = JSON.parse(readFileSync(cachePath, 'utf8')).checkpoint.readAt;
      f.advance();
      let remainingPages = 0, narrativeCalls = 0;
      let checkedFirstBatch: string[] = [];
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('`preference-input`')) {
          remainingPages++;
          return JSON.stringify(canonicalAnswer(preferenceFile(prompt)));
        }
        const { input } = storyFile(prompt);
        if (++narrativeCalls === 2) throw new Error('Narrative provider stopped');
        checkedFirstBatch = input.reviews.map((review: any) => review.groupId);
        return JSON.stringify({ narrative: checkedFirstBatch.join(', '), preferences: [] });
      }, 'api')).rejects.toThrow('Narrative provider stopped');
      expect(remainingPages).toBe(3);
      expect(readLedger(f.dir).story).toBeNull();
      f.advance();
      const resumed: string[] = [];
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        expect(prompt).not.toContain('`preference-input`');
        const { input } = storyFile(prompt);
        expect(input.reviews.every((review: any) => !checkedFirstBatch.includes(review.groupId))).toBe(true);
        resumed.push(...input.reviews.map((review: any) => review.groupId));
        return JSON.stringify({ narrative: `${input.previousStory.narrative}, ${input.reviews.map((review: any) => review.groupId).join(', ')}`, preferences: [] });
      }, 'api');
      expect([...checkedFirstBatch, ...resumed]).toEqual(f.ids);
      expect(readLedger(f.dir).story.writtenAt).toBe(new Date(priorReadAt).toISOString());
      expect(f.cli(['story-input']).reviews).toEqual([]);
    } finally { f.close(); }
  });

  it('saves a fully checked story after a storage failure without another model call', async () => {
    const f = fixture();
    let unregister = () => {};
    try {
      largePreferences(f);
      unregister = registerSharedFileWriter(f.dir, (name: string) => {
        if (name === 'story.json') throw new Error('Story storage unavailable');
        return null;
      });
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('`preference-input`')) return JSON.stringify(canonicalAnswer(preferenceFile(prompt)));
        const { input } = storyFile(prompt);
        return JSON.stringify({ narrative: `${input.previousStory?.narrative ?? ''}checked batch.`, preferences: [] });
      }, 'api')).rejects.toThrow('Story storage unavailable');
      expect(readLedger(f.dir).story).toBeNull();
      unregister();
      unregister = () => {};
      await f.task().run(async prompt => { throw new Error(`Already checked: ${prompt.slice(-80)}`); }, 'api');
      expect(readLedger(f.dir).story.narrative).toContain('checked batch.');
      expect(f.cli(['story-input']).reviews).toEqual([]);
    } finally { unregister(); f.close(); }
  });

  it('reuses immutable preference keys after source changes while invalidating narrative drafts', async () => {
    const f = fixture();
    try {
      largePreferences(f);
      let narratives = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('`preference-input`')) return JSON.stringify(canonicalAnswer(preferenceFile(prompt)));
        if (++narratives === 2) throw new Error('Stop after a checked narrative');
        return JSON.stringify({ narrative: 'Old source snapshot.', preferences: [] });
      }, 'api')).rejects.toThrow('Stop after a checked narrative');
      f.advance();
      const groupId = f.ids[0], review = readLedger(f.dir).progress[groupId];
      const preferences = [...review.preferences];
      preferences[0] = { ...preferences[0], quote: 'One changed immutable quote.' };
      f.cli(['record-progress'], { ...review, preferences, reviewBasis: f.cli(['show', groupId]).reviewBasis });
      let changedValues = 0, firstNarrative = true;
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('`preference-input`')) {
          const input = preferenceFile(prompt);
          changedValues += input.values.length;
          expect(input.values.map(value => value.evidence.quote)).toEqual(['One changed immutable quote.']);
          return JSON.stringify(canonicalAnswer(input));
        }
        const { input } = storyFile(prompt);
        if (firstNarrative) { expect(input.previousStory).toBeNull(); firstNarrative = false; }
        return JSON.stringify({ narrative: 'Updated source snapshot.', preferences: [] });
      }, 'api');
      expect(changedValues).toBe(1);
      expect(readLedger(f.dir).story.narrative).toBe('Updated source snapshot.');
    } finally { f.close(); }
  });

  it('invalidates canonical answers when the selected story model changes', async () => {
    const f = fixture();
    try {
      largePreferences(f);
      let calls = 0;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const input = preferenceFile(prompt);
        if (++calls === 2) throw new Error('Stop after checked keys');
        return JSON.stringify(canonicalAnswer(input));
      }, 'api')).rejects.toThrow('Stop after checked keys');
      writeFileSync(join(f.dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_API_MODEL: 'changed-model' }));
      let pages = 0;
      await f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('`preference-input`')) { pages++; return JSON.stringify(canonicalAnswer(preferenceFile(prompt))); }
        return JSON.stringify({ narrative: 'Checked using the new model.', preferences: [] });
      }, 'api');
      expect(pages).toBe(5);
    } finally { f.close(); }
  });

  it('stores request provenance privately and counts three old plus two new supporting requests exactly once', async () => {
    const f = fixture();
    try {
      largePreferences(f);
      const support = { kind: 'directive', preference: 'Keep changes focused.', quote: 'Keep each change focused.', at: null };
      const addSupport = (ids: string[]) => {
        for (const groupId of ids) {
          const review = readLedger(f.dir).progress[groupId];
          f.cli(['record-progress'], { ...review, preferences: [support, ...review.preferences.slice(1)],
            reviewBasis: f.cli(['show', groupId]).reviewBasis });
        }
      };
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('`preference-input`')) return JSON.stringify(canonicalAnswer(preferenceFile(prompt)));
        const { input, text } = storyFile(prompt);
        expect(text).not.toContain('requestIds');
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
        return JSON.stringify({ narrative: 'Checked evidence.', preferences: [] });
      };
      addSupport(f.ids.slice(0, 3));
      await f.task().run(ask, 'api');
      expect(readLedger(f.dir).story.preferences[0].supportCount).toBe(3);
      f.advance();
      addSupport(f.ids.slice(3, 5));
      await f.task().run(ask, 'api');
      expect(readLedger(f.dir).story.preferences[0].supportCount).toBe(5);
      f.advance();
      for (const groupId of f.ids.slice(0, 2)) {
        const review = readLedger(f.dir).progress[groupId];
        f.cli(['record-progress'], { ...review, percent: 50, reviewBasis: f.cli(['show', groupId]).reviewBasis });
      }
      await f.task().run(ask, 'api');
      const story = readLedger(f.dir).story;
      expect(story.preferences[0].supportCount).toBe(5);
      expect(JSON.stringify(story)).not.toContain('requestIds');
      const cache = JSON.parse(readFileSync(join(f.dir, 'story-preferences', 'state.json'), 'utf8'));
      const proof = cache.proofs.find((value: any) => value.storyHash === storyFingerprint(story));
      expect(proof.preferences[0].requestIds).toEqual([...f.ids.slice(0, 5)].sort());
      expect(proof.preferences[0].legacySupportCount).toBeUndefined();
    } finally { f.close(); }
  });

  it('keeps a 1100-request support set out of the shared story and all model inputs', async () => {
    const f = fixture(1);
    try {
      const raw = { preference: 'Run tests before committing.', kind: 'directive', quote: 'Run tests before committing.', at: null };
      const source = storyInput(1100, Array.from({ length: 1100 }, (_, id) => ({ groupId: `request-${id}`, preferences: [raw] })), null);
      const canonical: Record<string, any> = {};
      const resolved = await boundedStoryPreferences(source, storyPreferenceEvidence(source), async (input, validate) => {
        expect(JSON.stringify(input)).not.toContain('requestIds');
        expect(Buffer.byteLength(JSON.stringify(input, null, 2), 'utf8')).toBeLessThanOrEqual(INPUT_BYTES);
        return validate(canonicalAnswer(input));
      }, { saveCanonical: entries => Object.assign(canonical, entries) });
      f.cli(['record-story'], { narrative: 'All source requests retained.', preferences: resolved.preferences });
      const story = readLedger(f.dir).story;
      expect(story.preferences[0].supportCount).toBe(1100);
      expect(Buffer.byteLength(JSON.stringify(story), 'utf8')).toBeLessThan(48000);
      expect(JSON.stringify(story)).not.toContain('request-');
      const path = join(f.dir, 'story-preferences', 'state.json');
      writeStoryCache(path, { version: 1, context: 'shared-size-check', canonical, proofs: [{ storyHash: storyFingerprint(story), preferences: resolved.provenance }] });
      expect(readStoryCache(path, 'shared-size-check').proofs[0].preferences[0].requestIds).toHaveLength(1100);
    } finally { f.close(); }
  });

  it('a failed story stays due through the existing worker admission path, and cached answers alone stay idle', async () => {
    const f = fixture();
    let worker: AutoRefreshWorker | undefined;
    try {
      f.database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)')
        .run('owner', 'owner-goals', JSON.stringify({ human_summary: 'Current goals.', generated_at: new Date(NOW).toISOString() }), NOW);
      let first = true;
      await expect(f.task().run(async prompt => {
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (!first) throw new Error('Narrative interrupted');
        first = false;
        return JSON.stringify({ narrative: 'A checked prefix.', preferences: [] });
      }, 'api')).rejects.toThrow('Narrative interrupted');
      const cachePath = join(f.dir, 'story-preferences', 'state.json');
      const beforeAdmission = readFileSync(cachePath, 'utf8');
      let admitted = false, jobs = 0;
      worker = new AutoRefreshWorker({ dir: f.dir, localDeviceId: () => '', now: () => NOW,
        openDatabase: () => ({ prepare: f.database.prepare.bind(f.database), close() {} }),
        runJob: async () => {
          jobs++;
          if (!admitted) return { state: 'waiting-for-agent', agent: null, result: null, error: 'Authentication required' };
          return { state: 'ok', agent: 'api', error: null, result: await f.task().run(async prompt => {
            if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
            return JSON.stringify({ narrative: 'Finished after admission.', preferences: [] });
          }, 'api') };
        } });
      expect(worker.readNeeds()).toMatchObject({ due: 0, ungrouped: 0, goalsStale: false, unplaced: 0, otherChanged: false, needed: true });
      expect(await worker.runNow({ reason: 'manual' })).toBe('waiting-for-agent');
      expect(readFileSync(cachePath, 'utf8')).toBe(beforeAdmission);
      expect(readLedger(f.dir).story).toBeNull();
      admitted = true;
      expect(await worker.runNow({ reason: 'manual' })).toBe('ok');
      expect(existsSync(cachePath)).toBe(true);
      expect(await worker.runNow({ reason: 'manual' })).toBe('idle');
      expect(jobs).toBe(2);
    } finally { worker?.close(); f.close(); }
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

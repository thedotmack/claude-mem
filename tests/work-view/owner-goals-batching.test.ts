import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRefreshTask } from '../../src/services/work-view/refresh-task.js';
import { promptMinute, writeOwnerPromptsFile } from '../../src/services/prompt-import/owner-prompts-file.js';
import type { OwnerPrompt } from '../../src/services/prompt-import/index.js';
import { fakeOwnerGoalsWorker } from '../helpers/fake-owner-goals-worker.js';

const NOW = Date.UTC(2026, 10, 11, 12);
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');
const checkpointFile = (dir: string) => join(dir, 'owner-goals', 'mapping-checkpoint.json');

function prompts(count: number, padding = 200): OwnerPrompt[] {
  return Array.from({ length: count }, (_, index) => ({
    agent: 'codex', sessionId: 'owner-session', nativePromptId: String(index), at: NOW - 30_000,
    cwd: '/work/releases', project: 'releases', platformSource: 'codex',
    text: 'TURN: ' + index + '\nPlease keep releases and monitoring reliable. ' + 'x'.repeat(padding),
  }));
}

function harness(initial: OwnerPrompt[], afterWrite?: NonNullable<Parameters<typeof fakeOwnerGoalsWorker>[1]>['afterWrite']) {
  const dataDir = mkdtempSync(join(tmpdir(), 'owner-goals-batches-'));
  const ledgerDir = join(dataDir, 'work-view');
  mkdirSync(ledgerDir);
  const worker = fakeOwnerGoalsWorker(dataDir, { shared: true, afterWrite });
  const database = new Database(':memory:');
  database.exec('CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);'
    + 'CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);'
    + 'CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);'
    + 'CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);'
    + 'CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);');
  let source = initial, now = NOW;
  const openDatabase = () => {
    database.exec('DELETE FROM work_state_entries');
    const insert = database.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)');
    for (const row of worker.rows) insert.run(row.id, row.project, row.list_name, row.fields, row.created_at_epoch);
    return { prepare: database.prepare.bind(database), close() {} };
  };
  const spawnImpl = ((command: string, args: string[], options: any) => spawn(command, args,
    { ...options, env: { ...options?.env, ...worker.env } })) as typeof spawn;
  const task = () => buildRefreshTask({
    localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true },
    reason: 'manual', dataDir, ledgerDir, pluginRoot: PLUGIN_ROOT, openDatabase, spawnImpl, now: () => now,
    writeOwnerPrompts: (folder, sinceMinute) => writeOwnerPromptsFile({ folder, sinceMinute, now,
      scan: async () => ({ agents: [], ownerPrompts: source, agentWritten: [], ownerMemoryPromptIds: new Set<number>(), skippedSources: [] }) }),
  });
  return {
    dataDir, ledgerDir, worker, task, checkpoint: () => JSON.parse(readFileSync(checkpointFile(ledgerDir), 'utf8')),
    source: (value: OwnerPrompt[]) => { source = value; }, now: (value: number) => { now = value; },
    close() { worker.stop(); database.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function batchInput(question: string) {
  const match = /The next prompts, oldest first, are in (.+?\.json)\./.exec(question);
  if (!match) throw new Error('The model received the whole window instead of a bounded batch.');
  const markdown = readFileSync(match[1], 'utf8');
  const entries = [...markdown.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · [^\n]+\nsession [^\n]+\n\nTURN: ([^\n]+)/gm)]
    .map(match => ({ at: match[1], quote: 'TURN: ' + match[2], turn: match[2] }));
  const previous = /The checked cumulative goals are in (.+?\.json)\./.exec(question);
  return { markdown, entries, previous: previous ? JSON.parse(readFileSync(previous[1], 'utf8')) : null };
}

/** A deterministic model answer; quote checking and every save below use the real Python script and HTTP. */
function answer(question: string, seen: string[] = []) {
  const input = batchInput(question);
  seen.push(...input.entries.map(entry => entry.turn));
  const first = input.previous?.focus_areas?.[0]?.evidence?.[0] ?? input.entries[0];
  const last = input.entries.at(-1)!;
  const evidence = [first, last].map(({ at, quote }) => ({ at, quote }));
  return JSON.stringify({
    map: 'This batch covers ' + input.entries.map(entry => entry.turn).join(', ') + '.',
    goals: {
      window_days: 31, human_summary: 'Ship reliable releases.',
      focus_areas: ['Releases', 'Reliability'].map((title, index) => ({ title, rank: index + 1, goal: 'Keep this work reliable.',
        matches: input.previous?.focus_areas?.[index]?.matches ?? null, latest_at: last.at, times_asked: 2, evidence })),
      asks: [{ title: 'Ship the release', focus_area: 'Releases', rank: 1, latest_at: last.at, times_asked: 2, evidence }],
      rules: [{ when: '', then: 'Preserve checked changes.', latest_at: last.at, times_asked: 2, evidence }],
    },
  });
}

const run = async (fixture: ReturnType<typeof harness>, ask: (question: string) => Promise<string>) => {
  const task = fixture.task();
  await task.prepare!();
  return task.run(ask, 'api');
};
const watermarks = (fixture: ReturnType<typeof harness>) => fixture.worker.rows
  .filter(row => row.list_name === 'owner-goals' && !JSON.parse(row.fields).task);

describe('initial owner-goals batches', () => {
  it('bounds all 5,922 prompts without dropping either end of the window', async () => {
    const fixture = harness(prompts(5922));
    const seen: string[] = [];
    let calls = 0;
    try {
      expect(await run(fixture, async question => {
        calls++;
        expect(Buffer.byteLength(question)).toBeLessThanOrEqual(96 * 1024);
        expect(Buffer.byteLength(batchInput(question).markdown)).toBeLessThanOrEqual(32 * 1024);
        expect(watermarks(fixture)).toHaveLength(0);
        return answer(question, seen);
      })).toBe('goals mapped.');
      expect(calls).toBeGreaterThan(1);
      expect(seen).toEqual(Array.from({ length: 5922 }, (_, index) => String(index)));
      expect(fixture.worker.focusAreas()).toHaveLength(2);
      expect(watermarks(fixture)).toHaveLength(1);
      expect(JSON.parse(watermarks(fixture)[0].fields)).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 5922 });
      expect(existsSync(checkpointFile(fixture.ledgerDir))).toBe(false);
    } finally { fixture.close(); }
  }, 120_000);

  it('round trips Unicode and escaped focus payloads through Python without changing their save commitment', async () => {
    const fixture = harness(prompts(14, 2800));
    const title = 'İstanbul "quoted" \\ 🚀';
    try {
      await run(fixture, async question => {
        const value = JSON.parse(answer(question));
        value.goals.focus_areas[0].title = title;
        value.goals.focus_areas[0].goal = '完成发布\\路径\n并验证。';
        value.goals.asks[0].focus_area = title;
        return JSON.stringify(value);
      });
      expect(fixture.worker.focusAreas().some(area => area.name === title && area.goal === '完成发布\\路径\n并验证。')).toBe(true);
    } finally { fixture.close(); }
  }, 60_000);

  it('keeps strict quote validation and resumes only unfinished or changed source turns in the same minute', async () => {
    const source = prompts(36, 2800);
    const fixture = harness(source);
    let calls = 0;
    const first: string[] = [], resumed: string[] = [];
    try {
      await expect(run(fixture, async question => {
        if (++calls === 1) return answer(question, first);
        const invalid = JSON.parse(answer(question));
        invalid.goals.asks[0].evidence[0].quote = 'These words were never in an owner prompt.';
        return JSON.stringify(invalid);
      })).rejects.toThrow("quotes are not the owner's words");
      const checked = fixture.checkpoint();
      expect(checked.processed).toHaveLength(first.length);
      expect(checked.save).toBeNull();
      expect(fixture.worker.rows).toHaveLength(0);
      // An edit to a completed turn and two equal-text turns with distinct native identities all count.
      const edited = { ...source[1], text: source[1].text.replace('TURN: 1', 'TURN: edited') };
      const added = { ...source[0], nativePromptId: 'new-same-minute', text: source[0].text.replace('TURN: 0', 'TURN: added') };
      const equalText = { ...added, nativePromptId: 'new-same-text' };
      fixture.source(source.map((prompt, index) => index === 1 ? edited : prompt).concat(added, equalText));
      await run(fixture, async question => answer(question, resumed));
      expect(resumed).not.toContain('0');
      expect(resumed.filter(turn => turn === 'added')).toHaveLength(2);
      expect(resumed).toContain('edited');
      expect(resumed.filter(turn => !['edited', 'added'].includes(turn))).toEqual(source.slice(first.length).map(prompt => prompt.nativePromptId));
      expect(fixture.worker.focusAreas()).toHaveLength(2);
    } finally { fixture.close(); }
  }, 60_000);

  it('retains a completed no-goal batch without replaying it after a later model failure', async () => {
    const fixture = harness(prompts(28, 2800));
    const first: string[] = [], resumed: string[] = [];
    let calls = 0;
    try {
      await expect(run(fixture, async question => {
        if (++calls === 1) {
          first.push(...batchInput(question).entries.map(entry => entry.turn));
          return JSON.stringify({ map: 'No actionable goals in these prompts.', goals: null });
        }
        throw new Error('provider unavailable');
      })).rejects.toThrow('provider unavailable');
      expect(fixture.checkpoint().processed).toHaveLength(first.length);
      expect(fixture.checkpoint().goals).toBeNull();
      await run(fixture, async question => answer(question, resumed));
      expect(resumed).toEqual(Array.from({ length: 28 - first.length }, (_, index) => String(index + first.length)));
    } finally { fixture.close(); }
  }, 60_000);


  it('processes restored source turns after deletion without replaying unchanged completed turns', async () => {
    const source = prompts(28, 2800);
    const fixture = harness(source);
    const first: string[] = [], retained: string[] = [], restored: string[] = [];
    let calls = 0;
    try {
      await expect(run(fixture, async question => {
        if (++calls === 1) return answer(question, first);
        throw new Error('provider interrupted');
      })).rejects.toThrow('provider interrupted');
      const remaining = source.slice(first.length);
      fixture.source(remaining);
      expect(await run(fixture, async question => {
        retained.push(...batchInput(question).entries.map(entry => entry.turn));
        return JSON.stringify({ map: 'No actionable goals in these remaining prompts.', goals: null });
      })).toBe('no actionable goals found.');
      expect(retained).toEqual(remaining.map(prompt => prompt.nativePromptId));
      const retainedPositions = fixture.checkpoint().processed;
      expect(fixture.checkpoint().goals).toBeNull();
      fixture.source(source);
      await run(fixture, async question => answer(question, restored));
      expect(restored).toEqual(first);
      expect(retainedPositions).toHaveLength(remaining.length);
      expect(restored.some(turn => retained.includes(turn))).toBe(false);
    } finally { fixture.close(); }
  }, 60_000);

  it('does not repay for an entirely non-actionable window and continues the refresh', async () => {
    const fixture = harness(prompts(15, 2800));
    try {
      expect(await run(fixture, async () => JSON.stringify({ map: 'No actionable goals.', goals: null }))).toBe('no actionable goals found.');
      expect(fixture.checkpoint().processed).toHaveLength(15);
      expect(await run(fixture, async () => { throw new Error('completed empty batches must not be asked again'); })).toBe('no actionable goals found.');
      expect(fixture.worker.rows).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it('keeps progress when the whole question including the carried answer exceeds the budget', async () => {
    const fixture = harness(prompts(24, 2800));
    let calls = 0;
    try {
      await expect(run(fixture, async question => {
        calls++;
        const value = JSON.parse(answer(question));
        value.goals.human_summary = 'large checked aggregate '.repeat(6000);
        return JSON.stringify(value);
      })).rejects.toThrow('question budget');
      expect(calls).toBe(1);
      expect(fixture.checkpoint().processed.length).toBeGreaterThan(0);
      expect(fixture.worker.rows).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it('checks for a newer saved snapshot before committing the last batch', async () => {
    const fixture = harness(prompts(14, 2800));
    let calls = 0;
    try {
      await expect(run(fixture, async question => {
        const value = answer(question);
        if (++calls === 2) fixture.worker.rows.push({ id: 1, project: 'home', list_name: 'owner-goals',
          fields: JSON.stringify({ generated_at: new Date(NOW + 2000).toISOString() }), created_at_epoch: 1 });
        return value;
      })).rejects.toThrow('will not overwrite the newer snapshot');
      expect(fixture.worker.focusAreas()).toHaveLength(0);
      expect(fixture.checkpoint().save).not.toBeNull();
    } finally { fixture.close(); }
  }, 60_000);

  it('does not overwrite a snapshot saved elsewhere while the first mapping was incomplete', async () => {
    const fixture = harness(prompts(24, 2800));
    let calls = 0;
    try {
      await expect(run(fixture, async question => {
        if (++calls === 1) return answer(question);
        throw new Error('temporary provider failure');
      })).rejects.toThrow('temporary provider failure');
      fixture.worker.rows.push({ id: 1, project: 'home', list_name: 'owner-goals', fields: JSON.stringify({ generated_at: new Date(NOW + 1000).toISOString() }), created_at_epoch: 1 });
      await expect(run(fixture, async () => { throw new Error('must not ask'); })).rejects.toThrow('will not overwrite the newer snapshot');
      expect(existsSync(checkpointFile(fixture.ledgerDir))).toBe(true);
    } finally { fixture.close(); }
  });
});

describe('checked owner-goals final save recovery', () => {
  for (const phase of ['focus', 'focus-reply', 'item', 'rules', 'watermark'] as const) {
    it('finishes after a lost ' + phase + ' write reply without inference, duplicate IDs, or an early watermark', async () => {
      let fail = true;
      const fixture = harness(prompts(14, 2800), (written) => {
        if (fail && written === phase) { fail = false; throw new Error('reply lost after ' + phase); }
      });
      try {
        await expect(run(fixture, async question => answer(question))).rejects.toThrow('exited 3');
        const checked = fixture.checkpoint(), ids = fixture.worker.focusAreas().map(area => area.focusAreaId);
        expect(checked.save.key).toMatch(/^[a-f0-9]{24}:[a-f0-9]{64}$/);
        expect(checked.save.prompts).toBeUndefined();
        if (phase !== 'watermark') expect(watermarks(fixture)).toHaveLength(0);
        const area = fixture.worker.focusAreas()[0];
        if (area) fixture.worker.ownerDecides(area, { name: 'Owner name', status: 'dismissed' });
        // Retrying rules must reread the current story, rather than restore an old whole-story checkpoint.
        const storyPath = join(fixture.ledgerDir, 'story.json');
        const story = existsSync(storyPath) ? JSON.parse(readFileSync(storyPath, 'utf8')) : {};
        story.preferences = [...(story.preferences ?? []), { preference: 'Keep the owner edit.', kind: 'directive' }];
        writeFileSync(storyPath, JSON.stringify(story));
        fixture.now(NOW + 1000);
        expect(await run(fixture, async () => { throw new Error('a checked final save must not call the model'); })).toBe('goals mapped.');
        expect(fixture.worker.focusAreas()).toHaveLength(2);
        for (const id of ids) expect(fixture.worker.focusAreas().some(area => area.focusAreaId === id)).toBe(true);
        if (area) expect(fixture.worker.focusAreas().find(saved => saved.focusAreaId === area.focusAreaId)).toMatchObject({ name: 'Owner name', status: 'dismissed', decidedBy: 'owner' });
        expect(JSON.parse(readFileSync(storyPath, 'utf8')).preferences.some((preference: any) => preference.preference === 'Keep the owner edit.')).toBe(true);
        expect(JSON.parse(watermarks(fixture).at(-1)!.fields).generated_at).toBe(new Date(NOW).toISOString());
        expect(existsSync(checkpointFile(fixture.ledgerDir))).toBe(false);
      } finally { fixture.close(); }
    }, 60_000);
  }

  for (const change of ['delete', 'redact', 'empty-window'] as const) {
    it('refuses a checked save whose current evidence was changed: ' + change, async () => {
      const source = prompts(14, 2800);
      let fail = true;
      const fixture = harness(source, phase => {
        if (fail && phase === 'focus-reply') { fail = false; throw new Error('lost focus reply'); }
      });
      try {
        await expect(run(fixture, async question => answer(question))).rejects.toThrow('exited 3');
        const before = fixture.worker.rows.length;
        fixture.source(change === 'empty-window' ? [] : source.map((prompt, index) =>
          index === 0 ? { ...prompt, text: change === 'redact' ? '<private>' + prompt.text + '</private>' : 'Removed evidence.' } : prompt));
        await expect(run(fixture, async () => { throw new Error('must not infer again'); })).rejects.toThrow();
        expect(fixture.worker.rows).toHaveLength(before);
        expect(watermarks(fixture)).toHaveLength(0);
        expect(existsSync(checkpointFile(fixture.ledgerDir))).toBe(true);
      } finally { fixture.close(); }
    }, 60_000);
  }

  it('can finish its old checked snapshot when new prompts were added without changing its evidence', async () => {
    const source = prompts(14, 2800);
    let fail = true;
    const fixture = harness(source, phase => { if (fail && phase === 'item') { fail = false; throw new Error('lost item reply'); } });
    try {
      await expect(run(fixture, async question => answer(question))).rejects.toThrow('exited 3');
      fixture.source(source.concat({ ...source[0], nativePromptId: 'later', at: NOW + 500, text: 'TURN: later\nShip the follow-up.' }));
      fixture.now(NOW + 1000);
      await run(fixture, async () => { throw new Error('must only finish the checked save'); });
      const saved = JSON.parse(watermarks(fixture).at(-1)!.fields);
      expect(saved).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 14 });
      // The next normal incremental export begins at that old inclusive minute, so the added turn is still due.
      const next = writeOwnerPromptsFile({ folder: join(fixture.ledgerDir, 'next'), now: NOW + 1000,
        sinceMinute: promptMinute(NOW),
        scan: async () => ({ agents: [], ownerPrompts: source.concat({ ...source[0], nativePromptId: 'later', at: NOW + 500, text: 'TURN: later' }), agentWritten: [], ownerMemoryPromptIds: new Set<number>(), skippedSources: [] }) });
      expect((await next).newPrompts).toBe(1);
    } finally { fixture.close(); }
  }, 60_000);
});

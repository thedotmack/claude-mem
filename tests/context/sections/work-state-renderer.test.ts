import { describe, it, expect } from 'bun:test';
import type { WorkStateEntry, WorkStateFields } from '../../../src/services/sqlite/work-state.js';
import {
  buildWorkStateContextSection,
  foldWorkStateList,
  renderWorkStateLines,
  renderWorkStateList,
} from '../../../src/services/context/sections/WorkStateRenderer.js';

const NOW_EPOCH = Date.UTC(2026, 9, 2, 12, 0, 0);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let nextEntryId = 1;
function entry(listName: string, fields: WorkStateFields, ageMs: number): WorkStateEntry {
  return { id: nextEntryId++, project: 'acme', list_name: listName, fields, created_at_epoch: NOW_EPOCH - ageMs };
}

// The release the notch fixture modelled: 13.25.2 blocked on the npm token, then 13.25.3.
function releaseEntries(): WorkStateEntry[] {
  return [
    entry('release', { version: '13.25.2', status: 'blocked', blocked_on: 'npm token' }, 3 * DAY_MS),
    entry('release', { task: 'publish', status: 'todo' }, 3 * DAY_MS),
    entry('release', { task: 'pointer-comments', status: 'todo', issues: '3606 3794 4065 3829' }, 3 * DAY_MS),
    entry('release', { task: 'timeout-decision', status: 'todo' }, 3 * DAY_MS),
    entry('release', { version: '13.25.3', status: 'active', blocked_on: null }, 5 * MINUTE_MS),
    entry('release', { task: 'publish', status: 'dropped', reason: 'superseded by 13.25.3' }, 5 * MINUTE_MS),
    entry('release', { task: 'pointer-comments', status: 'doing' }, 5 * MINUTE_MS),
  ];
}

describe('foldWorkStateList', () => {
  it('keeps the latest value of each key, separately for the list state and each task', () => {
    const folded = foldWorkStateList([
      entry('plan', { phase: 'plan', step: 1 }, 10 * MINUTE_MS),
      entry('plan', { task: 'write-tests', status: 'todo' }, 9 * MINUTE_MS),
      entry('plan', { step: 2 }, 8 * MINUTE_MS),
      entry('plan', { task: 'write-tests', status: 'done', note: 'all green' }, 7 * MINUTE_MS),
      entry('plan', { task: 'open-pr' }, 6 * MINUTE_MS),
    ]);

    expect(folded.state).toEqual({ phase: 'plan', step: 2 });
    expect(folded.stateUpdatedAtEpoch).toBe(NOW_EPOCH - 8 * MINUTE_MS);
    expect([...folded.tasks.keys()]).toEqual(['write-tests', 'open-pr']);
    expect(folded.tasks.get('write-tests')).toEqual({
      fields: { task: 'write-tests', status: 'done', note: 'all green' },
      updatedAtEpoch: NOW_EPOCH - 7 * MINUTE_MS,
    });
  });
});

describe('renderWorkStateList', () => {
  it('shows what is open with how long ago each item last changed, skipping cleared keys', () => {
    expect(renderWorkStateList('release', foldWorkStateList(releaseEntries()), NOW_EPOCH)).toEqual([
      '- release: version=13.25.3, status=active, updated 5 minutes ago',
      '  - [doing] pointer-comments (issues=3606 3794 4065 3829), updated 5 minutes ago',
      '  - [todo] timeout-decision, updated about 3 days ago',
    ]);
  });

  it('hides done and dropped tasks, and a list whose own status is done', () => {
    const finished = foldWorkStateList([
      entry('migration', { migration: 'sqlite-v8', status: 'done' }, MINUTE_MS),
      entry('migration', { task: 'backup', status: 'done' }, MINUTE_MS),
      entry('migration', { task: 'rollback-plan', status: 'dropped' }, MINUTE_MS),
    ]);

    expect(renderWorkStateList('migration', finished, NOW_EPOCH)).toEqual([]);
  });

  it('still shows a task left open in a list that was closed', () => {
    const closedWithOpenTask = foldWorkStateList([
      entry('migration', { migration: 'sqlite-v8', status: 'done' }, MINUTE_MS),
      entry('migration', { task: 'drop-old-table', status: 'todo' }, MINUTE_MS),
    ]);

    expect(renderWorkStateList('migration', closedWithOpenTask, NOW_EPOCH)).toEqual([
      '- migration',
      '  - [todo] drop-old-table, updated 1 minute ago',
    ]);
  });

  it('shows closed items when asked to', () => {
    const lines = renderWorkStateList('release', foldWorkStateList(releaseEntries()), NOW_EPOCH, true);

    expect(lines).toContain('  - [dropped] publish (reason=superseded by 13.25.3), updated 5 minutes ago');
  });
});

describe('renderWorkStateLines', () => {
  it('puts the most recently written list first', () => {
    const entries = [
      entry('todo', { task: 'update-docs', status: 'todo' }, 2 * DAY_MS),
      ...releaseEntries(),
    ];

    const lines = renderWorkStateLines(entries, NOW_EPOCH);

    expect(lines[0]).toStartWith('- release:');
    expect(lines.slice(-2)).toEqual(['- todo', '  - [todo] update-docs, updated about 2 days ago']);
  });
});

describe('buildWorkStateContextSection', () => {
  it('gives the rule, naming the tools, then what is still open', () => {
    const section = buildWorkStateContextSection(releaseEntries(), NOW_EPOCH);

    expect(section).toStartWith("# Work state: your to-do lists and working state\nUse claude-mem's work_state_write tool to track all to-do lists and multi-step work.");
    expect(section).toContain('It is your canonical to-do list: use it instead of any built-in to-do tool.');
    // A bare work_state_read shows only what is open, so the hint for closed items names the flag.
    expect(section).toContain('\n- Read every list, closed items included: work_state_read with includeClosed=true\n');
    expect(section).toContain('\n\nStill open:\n- release: version=13.25.3');
    expect(section).toEndWith('  - [todo] timeout-decision, updated about 3 days ago');
  });

  it('says nothing is open when nothing has been written', () => {
    expect(buildWorkStateContextSection([], NOW_EPOCH)).toEndWith('\n\nNothing open yet.');
  });

  it('stays within its character limit and says how many lines it left out', () => {
    const entries = releaseEntries();
    const fullSection = buildWorkStateContextSection(entries, NOW_EPOCH);
    const characterLimit = fullSection.length - 40;

    const truncatedSection = buildWorkStateContextSection(entries, NOW_EPOCH, characterLimit);

    expect(truncatedSection.length).toBeLessThanOrEqual(characterLimit);
    expect(truncatedSection).toMatch(/\n- \.\.\.\d+ more lines?; read them with work_state_read$/);
    const keptPart = truncatedSection.slice(0, truncatedSection.lastIndexOf('\n- ...'));
    expect(fullSection.startsWith(keptPart)).toBe(true);
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { formatJournalLine } from '../../src/services/working/journal.js';
import {
  renderWorkingMemoryBlock,
  WORKING_MEMORY_EMPTY_REMINDER,
} from '../../src/services/working/render.js';
import type { WorkingEntry } from '../../src/services/working/store.js';

describe('formatJournalLine', () => {
  it('renders file tools as "<Tool> <path>"', () => {
    expect(formatJournalLine('Read', { file_path: 'src/x.ts' })).toBe('Read src/x.ts');
    expect(formatJournalLine('Edit', { file_path: 'tests/y.ts' })).toBe('Edit tests/y.ts');
    expect(formatJournalLine('Write', { file_path: '/tmp/z.md' })).toBe('Write /tmp/z.md');
    expect(formatJournalLine('NotebookEdit', { notebook_path: 'nb.ipynb' })).toBe('NotebookEdit nb.ipynb');
  });

  it('renders successful Bash calls with the command', () => {
    expect(formatJournalLine('Bash', { command: 'bun test' }, { exitCode: 0 }))
      .toBe('Bash: bun test');
    expect(formatJournalLine('Bash', { command: 'git status' }))
      .toBe('Bash: git status');
  });

  it('marks failed Bash calls with the exit code', () => {
    expect(formatJournalLine('Bash', { command: 'bun test' }, { exitCode: 1 }))
      .toBe('Bash failed: bun test (exit 1)');
    // Claude Code string-shaped error response.
    expect(formatJournalLine('Bash', { command: 'bun build' }, 'Exit code 2\n...'))
      .toBe('Bash failed: bun build (exit 2)');
    expect(formatJournalLine('Bash', { command: 'make' }, { interrupted: true }))
      .toBe('Bash failed: make (interrupted)');
  });

  it('collapses multiline commands into one line', () => {
    expect(formatJournalLine('Bash', { command: 'cd x &&\nbun test' }))
      .toBe('Bash: cd x && bun test');
  });

  it('renders search and agent tools with their key argument', () => {
    expect(formatJournalLine('Grep', { pattern: 'TODO' })).toBe('Grep TODO');
    expect(formatJournalLine('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts');
    expect(formatJournalLine('Task', { description: 'explore routes' })).toBe('Agent: explore routes');
    expect(formatJournalLine('WebSearch', { query: 'bun sqlite' })).toBe('WebSearch bun sqlite');
  });

  it('falls back to a truncated JSON summary for unknown tools', () => {
    expect(formatJournalLine('CustomTool', { foo: 'bar' })).toBe('CustomTool: {"foo":"bar"}');
    expect(formatJournalLine('CustomTool')).toBe('CustomTool');
  });

  it('caps line length', () => {
    const line = formatJournalLine('Bash', { command: 'x'.repeat(500) });
    expect(line.length).toBeLessThanOrEqual(120);
  });
});

const entry = (over: Partial<WorkingEntry>): WorkingEntry => ({
  id: 1,
  project: 'proj',
  task_key: 'default',
  key: 'k',
  kind: 'intent',
  value: 'v',
  source: 'agent',
  created_at_epoch: 0,
  updated_at_epoch: 0,
  expires_at_epoch: Number.MAX_SAFE_INTEGER,
  ...over,
});

describe('renderWorkingMemoryBlock', () => {
  it('returns null for an empty set', () => {
    expect(renderWorkingMemoryBlock({ entries: [] })).toBeNull();
  });

  it('renders intents sorted by key, journal as a timeline, with an updated stamp', () => {
    const block = renderWorkingMemoryBlock({
      entries: [
        entry({ id: 1, key: 'next', value: 'run tests', updated_at_epoch: 2000 }),
        entry({ id: 2, key: 'hypothesis', value: 'cache bug', updated_at_epoch: 3000 }),
        entry({ id: 3, key: 'journal:1', kind: 'journal', source: 'observer', value: 'Read src/x.ts', updated_at_epoch: 1000 }),
        entry({ id: 4, key: 'journal:2', kind: 'journal', source: 'observer', value: 'Bash failed: bun test (exit 1)', updated_at_epoch: 4000 }),
      ],
    });

    expect(block).toBe([
      '## Working Memory — task: default (updated 00:00)',
      '- [intent] hypothesis: cache bug',
      '- [intent] next: run tests',
      '- [journal] Read src/x.ts',
      '- [journal] Bash failed: bun test (exit 1)',
    ].join('\n'));
  });

  it('renders the updated stamp from the newest entry (HH:MM UTC)', () => {
    const ts = new Date('2026-08-18T12:04:00Z').getTime();
    const block = renderWorkingMemoryBlock({
      entries: [entry({ key: 'a', value: '1', updated_at_epoch: ts })],
    });
    expect(block).toContain('(updated 12:04)');
  });

  it('appends the no-intent nudge to a journal-only block (intent absence is the trigger)', () => {
    const block = renderWorkingMemoryBlock({
      entries: [
        entry({ key: 'journal:1', kind: 'journal', source: 'observer', value: 'Read src/x.ts' }),
      ],
    });
    expect(block).toContain('- [journal] Read src/x.ts');
    expect(block).toContain('No intent recorded');

    // With at least one intent entry the nudge disappears.
    const withIntent = renderWorkingMemoryBlock({
      entries: [
        entry({ key: 'hyp', value: 'cache bug' }),
        entry({ key: 'journal:1', kind: 'journal', source: 'observer', value: 'Read src/x.ts' }),
      ],
    });
    expect(withIntent).not.toContain('No intent recorded');
  });

  it('per-task nudge: intent in one task does not silence the nudge of a journal-only task', () => {
    const block = renderWorkingMemoryBlock({
      entries: [
        entry({ task_key: 'busy', key: 'hyp', value: 'cache bug' }),
        entry({ task_key: 'quiet', key: 'journal:1', kind: 'journal', source: 'observer', value: 'Read src/x.ts' }),
      ],
    });
    const sections = block!.split(/(?=## Working Memory — task: )/);
    const busySection = sections.find(s => s.includes('task: busy')) ?? '';
    const quietSection = sections.find(s => s.includes('task: quiet')) ?? '';
    expect(busySection).not.toContain('No intent recorded');
    expect(quietSection).toContain('No intent recorded');
  });

  it('groups multiple tasks into separate sections', () => {
    const block = renderWorkingMemoryBlock({
      entries: [
        entry({ task_key: 'default', key: 'a', value: '1' }),
        entry({ task_key: 'bugfix', key: 'b', value: '2' }),
      ],
    });
    expect(block).toContain('## Working Memory — task: bugfix');
    expect(block).toContain('## Working Memory — task: default');
    expect(block!.indexOf('task: bugfix')).toBeLessThan(block!.indexOf('task: default'));
  });

  it('exposes the empty-set reminder text', () => {
    expect(WORKING_MEMORY_EMPTY_REMINDER).toContain('working_set');
  });
});

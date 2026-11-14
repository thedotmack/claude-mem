import { describe, expect, it } from 'bun:test';
import { reduceWorkState } from '../../src/services/work-view/work-state-reduce.mjs';
import { workStateItems } from '../../src/services/work-view/work-state-labels.mjs';

const NOW = Date.UTC(2026, 10, 14);
const row = (id: number, list: string, fields: Record<string, unknown>, at = NOW + id, project = 'repo') =>
  ({ id, project, list_name: list, fields: JSON.stringify(fields), created_at_epoch: at });

describe('work-state item version lookup', () => {
  it('reads history a bounded number of times across many lists', () => {
    const rows = [];
    for (let i = 1; i <= 200; i++) rows.push(row(i, `list-${i}`, { phase: 'Planning' }));
    for (let i = 1; i <= 200; i++) rows.push(row(200 + i, `list-${i}`, { task: 'Build', status: 'doing' }));
    const state = reduceWorkState(rows);
    let visited = 0;
    state.events = state.events.map((event: any) => ({ ...event, get listId() { visited++; return event.listId; } }));
    const items = workStateItems(state);

    expect(items).toHaveLength(400);
    expect(items.find(item => item.list.name === 'list-1' && item.recordKind === 'task')?.labelKey).toBe('201:1');
    expect(items.find(item => item.list.name === 'list-200' && item.recordKind === 'task')?.labelKey).toBe('400:200');
    expect(visited).toBeLessThanOrEqual(3 * state.events.length);
  });

  it('keeps the first canonical state event, even when its local id is lower', () => {
    const state = reduceWorkState([
      { ...row(50, 'release', { phase: 'Earlier' }, NOW), origin_device_id: 'a', origin_local_id: '9' },
      { ...row(2, 'release', { phase: 'Later' }, NOW), origin_device_id: 'b', origin_local_id: '1' },
      row(70, 'release', { task: 'Build', status: 'doing' }, NOW + 1),
      row(90, 'release', { phase: 'Other project' }, NOW + 2, 'other'),
    ]);
    const items = workStateItems(state);
    const local = items.filter(item => item.list.project === 'repo');
    expect(local.map(item => [item.recordKind, item.labelKey, item.latestEntryId])).toEqual([
      ['task', '70:2', 70], ['list', '2', 2],
    ]);
    expect(items.find(item => item.list.project === 'other')?.labelKey).toBe('90');
    expect(local[0].list.fields.phase).toBe('Later');
  });

  it('keeps task-only and cleared-note label keys and the order of returned items', () => {
    const state = reduceWorkState([
      row(1, 'notes', { phase: 'Drafting' }),
      row(2, 'notes', { task: 'First', status: 'doing' }),
      row(3, 'notes', { task: 'Second', status: 'todo' }),
      row(4, 'notes', { phase: null }),
      row(5, 'task-only', { task: 'Third', status: 'doing' }),
    ]);
    const before = structuredClone(state);
    expect(workStateItems(state).map(item => [item.name, item.recordKind, item.labelKey])).toEqual([
      ['Third', 'task', '5'], ['First', 'task', '2'], ['Second', 'task', '3'],
    ]);
    expect(state).toEqual(before);
  });

  it('uses only retained events and does not cache versions across reads', () => {
    const state = reduceWorkState([
      row(1, 'release', { phase: 'Drafting' }),
      row(2, 'release', { task: 'Build', status: 'doing' }),
    ]);
    const original = workStateItems(state);
    expect(original.map(item => item.labelKey)).toEqual(['2:1', '1']);
    state.events = state.events.filter((event: any) => event.task !== null);
    expect(workStateItems(state).map(item => item.labelKey)).toEqual(['2:0', '0']);
    state.events.unshift({ ...original[0].list, listId: original[0].list.id, task: null, id: 3 });
    expect(workStateItems(state).map(item => item.labelKey)).toEqual(['2:3', '3']);
    expect(original.map(item => item.labelKey)).toEqual(['2:1', '1']);
  });

  it('does not scan history when every list belongs to a system feature', () => {
    const state = reduceWorkState([
      row(1, 'my-rules', { task: 'Rule: one', status: 'doing' }),
      row(2, 'my-focus', { task: 'Focus area: one', status: 'doing' }),
      row(3, 'owner-goals', { task: 'Ask: one', status: 'doing' }),
    ]);
    Object.defineProperty(state, 'events', { get() { throw new Error('System lists need no item history'); } });
    expect(workStateItems(state)).toEqual([]);
  });

  it('stops after finding the requested state versions without walking older history', () => {
    const state = reduceWorkState([
      row(1, 'release', { phase: 'Drafting' }),
      row(2, 'release', { phase: 'Shipping' }),
    ]);
    Object.defineProperty(state.events[1], 'task', { get() { throw new Error('Older state is not needed'); } });
    expect(workStateItems(state).map(item => item.labelKey)).toEqual(['2']);
  });
});

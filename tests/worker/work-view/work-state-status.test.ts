// "Is this item closed?" has one definition (work-state-status.mjs). These tests hold every reader of work state to
// it: the SessionStart section, the read reply, My Work's reducer and view, the owner-goals reader and the write route.
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildWorkStateContextSection, renderWorkStateLines } from '../../../src/services/context/sections/WorkStateRenderer.js';
import { buildAgentView } from '../../../src/services/work-view/agent-view.mjs';
import { readGoals } from '../../../src/services/work-view/request-groups.mjs';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';
import { isClosedWorkStateStatus } from '../../../src/services/work-view/work-state-status.mjs';
import { ownerGoalsRowRefusal } from '../../../src/services/worker/http/routes/WorkStateRoutes.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function storeWith(rows: Array<{ listName: string; fields: Record<string, string | number | boolean | null> }>) {
  const database = new Database(':memory:');
  const store = new SessionStore(database);
  cleanup.push(() => database.close());
  for (const row of rows) store.appendWorkStateEntry({ project: 'repo', listName: row.listName, fields: row.fields });
  return { database, entries: store.getWorkStateEntries(['repo']) };
}

describe('isClosedWorkStateStatus', () => {
  it('closes on done and dropped in any letter case', () => {
    for (const status of ['done', 'dropped', 'Done', 'DROPPED', 'dOnE']) expect(isClosedWorkStateStatus(status)).toBe(true);
  });

  it('leaves every other status, and no status, open', () => {
    for (const status of ['todo', 'doing', 'open', 'completed', 'failed', 'blocked', '', 0, false, null, undefined]) {
      expect(isClosedWorkStateStatus(status)).toBe(false);
    }
  });
});

describe('every reader of work state agrees on what is closed', () => {
  const rows = [
    { listName: 'release', fields: { task: 'tag', status: 'Done' } },
    { listName: 'release', fields: { task: 'announce', status: 'DROPPED' } },
    { listName: 'release', fields: { task: 'publish', status: 'doing' } },
    { listName: 'release', fields: { task: 'verify', status: 'completed' } },
    { listName: 'cleanup', fields: { goal: 'remove the old queue', status: 'Done' } },
  ];
  const openTasks = ['publish', 'verify'];
  const closedTasks = ['tag', 'announce'];

  it('SessionStart and the read reply show the same open items', () => {
    const { entries } = storeWith(rows);
    const sessionStartSection = buildWorkStateContextSection(entries, Date.now());
    const readReply = renderWorkStateLines(entries, Date.now()).join('\n');

    for (const surface of [sessionStartSection, readReply]) {
      for (const task of openTasks) expect(surface).toContain(task);
      for (const task of closedTasks) expect(surface).not.toContain(task);
      expect(surface).not.toContain('remove the old queue');
    }
  });

  it('My Work marks the same items open, in its reducer and in its view', () => {
    const { entries } = storeWith(rows);
    const state = reduceWorkState(entries);
    const tasks = state.lists.flatMap((list: any) => list.tasks);

    expect(tasks.filter((task: any) => task.isOpen).map((task: any) => task.name).sort()).toEqual([...openTasks].sort());
    expect(tasks.filter((task: any) => !task.isOpen).map((task: any) => task.name).sort()).toEqual([...closedTasks].sort());
    expect(state.lists.find((list: any) => list.name === 'cleanup')).toMatchObject({ status: 'done', isOpen: false });

    const openByTitle = new Map((buildAgentView(state, {}) as any).unlinkedWork.map((item: any) => [item.title, item.isOpen]));
    expect(openByTitle.get('cleanup')).toBe(false);
    expect(openByTitle.get('tag')).toBe(false);
    expect(openByTitle.get('publish')).toBe(true);
    expect(openByTitle.get('verify')).toBe(true);
  });

  it('the owner-goals reader leaves out a goal closed in any letter case', () => {
    const { database } = storeWith([
      { listName: 'owner-goals', fields: { task: 'Ask: ship it', status: 'todo', goal_kind: 'ask', title: 'Ship it' } },
      { listName: 'owner-goals', fields: { task: 'Ask: old idea', status: 'todo', goal_kind: 'ask', title: 'Old idea' } },
      { listName: 'owner-goals', fields: { task: 'Ask: old idea', status: 'Dropped' } },
    ]);

    expect(readGoals(database).goals.map(goal => goal.title)).toEqual(['Ship it']);
  });

  it('the write route accepts an owner-goals row that only closes an item, in any letter case', () => {
    for (const status of ['done', 'dropped', 'Done', 'DROPPED']) {
      expect(ownerGoalsRowRefusal({ task: 'Ask: old idea', status })).toBeNull();
    }
    expect(ownerGoalsRowRefusal({ task: 'Ask: old idea', status: 'todo' })).toContain('goal_kind');
  });
});

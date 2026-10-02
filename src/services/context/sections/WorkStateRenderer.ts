import type { WorkStateEntry, WorkStateFields, WorkStateValue } from '../../sqlite/work-state.js';
import { describeDuration } from '../../../shared/observer-health.js';

/** Keeps the section small enough to leave most of the 10K hook budget to memory. */
export const WORK_STATE_SECTION_CHARACTER_LIMIT = 3_000;

const CLOSED_STATUSES = new Set(['done', 'dropped']);

const WORK_STATE_RULE = [
  '# Work state: your to-do lists and working state',
  "Use claude-mem's work_state_write tool to track all to-do lists and multi-step work. It is your canonical to-do list: use it instead of any built-in to-do tool. Also use it to track the state of anything you need an ongoing understanding of. Whatever is still open is shown here at the start of every session in this project.",
  '- One list per to-do list or tracked thing: work_state_write with list="<name>" and the fields to set',
  '- To-do item: fields {"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...any details}',
  '- State: fields {"<key>": <value>} (the latest value of each key wins; null clears a key; "status": "done" closes the list)',
  '- Read every list, closed items included: work_state_read',
].join('\n');

export interface FoldedWorkStateList {
  /** Latest value of every key written without a `task`. */
  state: WorkStateFields;
  stateUpdatedAtEpoch: number | null;
  /** Latest fields of each task, in first-seen order. */
  tasks: Map<string, { fields: WorkStateFields; updatedAtEpoch: number }>;
}

/** Replay one list's entries in order; the latest value of each key wins. */
export function foldWorkStateList(entries: WorkStateEntry[]): FoldedWorkStateList {
  const folded: FoldedWorkStateList = { state: {}, stateUpdatedAtEpoch: null, tasks: new Map() };
  for (const entry of entries) {
    const taskName = entry.fields.task;
    if (taskName === undefined || taskName === null || taskName === '') {
      Object.assign(folded.state, entry.fields);
      folded.stateUpdatedAtEpoch = entry.created_at_epoch;
      continue;
    }
    const taskKey = String(taskName);
    folded.tasks.set(taskKey, {
      fields: { ...folded.tasks.get(taskKey)?.fields, ...entry.fields },
      updatedAtEpoch: entry.created_at_epoch,
    });
  }
  return folded;
}

function isClosed(status: WorkStateValue | undefined): boolean {
  return status !== undefined && status !== null && CLOSED_STATUSES.has(String(status).toLowerCase());
}

/** `key=value` pairs; null values are skipped because null clears a key. */
function formatFields(fields: WorkStateFields, omittedKeys: string[]): string {
  return Object.entries(fields)
    .filter(([key, value]) => !omittedKeys.includes(key) && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

function updatedAgo(epoch: number, nowEpoch: number): string {
  return `updated ${describeDuration(nowEpoch - epoch)} ago`;
}

/**
 * Lines for one list. A closed list hides its state line but still shows any
 * task left open in it; `includeClosed` shows everything.
 */
export function renderWorkStateList(
  listName: string,
  folded: FoldedWorkStateList,
  nowEpoch: number,
  includeClosed: boolean = false,
): string[] {
  const taskLines = [...folded.tasks.entries()]
    .filter(([, task]) => includeClosed || !isClosed(task.fields.status))
    .map(([taskName, task]) => {
      const status = task.fields.status === undefined || task.fields.status === null ? '' : `[${String(task.fields.status)}] `;
      const details = formatFields(task.fields, ['task', 'status']);
      return `  - ${status}${taskName}${details ? ` (${details})` : ''}, ${updatedAgo(task.updatedAtEpoch, nowEpoch)}`;
    });

  const stateFields = formatFields(folded.state, ['task']);
  const showState = stateFields !== '' && (includeClosed || !isClosed(folded.state.status));
  if (!showState && taskLines.length === 0) return [];

  const stateUpdatedAtEpoch = folded.stateUpdatedAtEpoch ?? nowEpoch;
  const header = showState
    ? `- ${listName}: ${stateFields}, ${updatedAgo(stateUpdatedAtEpoch, nowEpoch)}`
    : `- ${listName}`;
  return [header, ...taskLines];
}

/** Lines for every list in `entries`, the most recently written list first. */
export function renderWorkStateLines(entries: WorkStateEntry[], nowEpoch: number, includeClosed: boolean = false): string[] {
  const entriesByList = new Map<string, WorkStateEntry[]>();
  for (const entry of entries) {
    const listEntries = entriesByList.get(entry.list_name) ?? [];
    listEntries.push(entry);
    entriesByList.set(entry.list_name, listEntries);
  }
  return [...entriesByList.entries()]
    .sort(([, a], [, b]) => b[b.length - 1].id - a[a.length - 1].id)
    .flatMap(([listName, listEntries]) =>
      renderWorkStateList(listName, foldWorkStateList(listEntries), nowEpoch, includeClosed));
}

/** The SessionStart section: the rule, then what is still open, cut to `characterLimit`. */
export function buildWorkStateContextSection(
  entries: WorkStateEntry[],
  nowEpoch: number,
  characterLimit: number = WORK_STATE_SECTION_CHARACTER_LIMIT,
): string {
  const openLines = renderWorkStateLines(entries, nowEpoch);
  if (openLines.length === 0) {
    return `${WORK_STATE_RULE}\n\nNothing open yet.`;
  }

  let section = `${WORK_STATE_RULE}\n\nStill open:`;
  for (let index = 0; index < openLines.length; index++) {
    const remaining = openLines.length - index;
    const overflowLine = `\n- ...${remaining} more line${remaining === 1 ? '' : 's'}; read them with work_state_read`;
    const candidate = `${section}\n${openLines[index]}`;
    const needsOverflowRoom = index < openLines.length - 1;
    if (candidate.length + (needsOverflowRoom ? overflowLine.length : 0) > characterLimit) {
      return section + overflowLine;
    }
    section = candidate;
  }
  return section;
}

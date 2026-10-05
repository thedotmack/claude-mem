import type { WorkStateEntry, WorkStateFields, WorkStateValue } from '../../sqlite/work-state.js';
import { describeDuration } from '../../../shared/observer-health.js';
import { relativeTimePlaceholder } from '../../../shared/context-cache.js';

/**
 * When "updated N ago" is measured from: an epoch, or 'placeholders' to leave
 * the durations as placeholders that `fillContextPlaceholders` measures at read
 * time (the cached SessionStart block, shared/context-cache.ts).
 */
export type WorkStateClock = number | 'placeholders';

/** Keeps the section small enough to leave most of the 10K hook budget to memory. */
export const WORK_STATE_SECTION_CHARACTER_LIMIT = 3_000;

const CLOSED_STATUSES = new Set(['done', 'dropped']);

const WORK_STATE_RULE = [
  '# Work state: your to-do lists and working state',
  "Use claude-mem's work_state_write tool to track all to-do lists and multi-step work. It is your canonical to-do list: use it instead of any built-in to-do tool. Also use it to track the state of anything you need an ongoing understanding of. Whatever is still open is shown here at the start of every session in this project.",
  '- One list per to-do list or tracked thing: work_state_write with list="<name>" and the fields to set',
  '- To-do item: fields {"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...any details}',
  '- State: fields {"<key>": <value>} (the latest value of each key wins; null clears a key; "status": "done" closes the list)',
  '- Read every list, closed items included: work_state_read with includeClosed=true',
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

function updatedAgo(epoch: number, nowEpoch: WorkStateClock): string {
  const duration = nowEpoch === 'placeholders' ? relativeTimePlaceholder(epoch) : describeDuration(nowEpoch - epoch);
  return `updated ${duration} ago`;
}

/**
 * Lines for one list. A closed list hides its state line but still shows any
 * task left open in it; `includeClosed` shows everything.
 */
export function renderWorkStateList(
  listName: string,
  folded: FoldedWorkStateList,
  nowEpoch: WorkStateClock,
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

  // A shown state line always has a state entry behind it; the fallback only satisfies the type.
  const stateUpdatedAtEpoch = folded.stateUpdatedAtEpoch ?? (nowEpoch === 'placeholders' ? 0 : nowEpoch);
  const header = showState
    ? `- ${listName}: ${stateFields}, ${updatedAgo(stateUpdatedAtEpoch, nowEpoch)}`
    : `- ${listName}`;
  return [header, ...taskLines];
}

/** Lines for every list in `entries`, the most recently written list first. */
export function renderWorkStateLines(entries: WorkStateEntry[], nowEpoch: WorkStateClock, includeClosed: boolean = false): string[] {
  const entriesByList = new Map<string, WorkStateEntry[]>();
  const listProjectCounts = new Map<string, number>();
  for (const entry of entries) {
    // Checkout aliases share one list; adopted source projects keep separate lists.
    const projectKey = (entry.scope_project ?? entry.project).replace(/[A-Z]/g, character => character.toLowerCase());
    const key = JSON.stringify([projectKey, entry.list_name]);
    let listEntries = entriesByList.get(key);
    if (!listEntries) {
      listEntries = [];
      entriesByList.set(key, listEntries);
      listProjectCounts.set(entry.list_name, (listProjectCounts.get(entry.list_name) ?? 0) + 1);
    }
    listEntries.push(entry);
  }
  return [...entriesByList.values()]
    .sort((a, b) => b[b.length - 1].id - a[a.length - 1].id)
    .flatMap(listEntries => {
      const first = listEntries[0];
      const label = (listProjectCounts.get(first.list_name) ?? 0) > 1
        ? `${first.list_name} [${first.scope_project ?? first.project}]`
        : first.list_name;
      return renderWorkStateList(label, foldWorkStateList(listEntries), nowEpoch, includeClosed);
    });
}

/** The SessionStart section: the rule, then what is still open, cut to `characterLimit`. */
export function buildWorkStateContextSection(
  entries: WorkStateEntry[],
  nowEpoch: WorkStateClock,
  characterLimit: number = WORK_STATE_SECTION_CHARACTER_LIMIT,
): string {
  const openLines = renderWorkStateLines(entries, nowEpoch);
  if (openLines.length === 0) {
    return `${WORK_STATE_RULE}\n\nNothing open yet.`;
  }
  return fitWorkStateLines(`${WORK_STATE_RULE}\n\nStill open:`, openLines, characterLimit);
}

/** `heading`, then as many of `lines` as fit in `characterLimit`, then how many were left out. */
export function fitWorkStateLines(heading: string, lines: string[], characterLimit: number): string {
  let text = heading;
  for (let index = 0; index < lines.length; index++) {
    const remaining = lines.length - index;
    const overflowLine = `\n- ...${remaining} more line${remaining === 1 ? '' : 's'}; read them with work_state_read`;
    const candidate = `${text}\n${lines[index]}`;
    const needsOverflowRoom = index < lines.length - 1;
    if (candidate.length + (needsOverflowRoom ? overflowLine.length : 0) > characterLimit) {
      return text + overflowLine;
    }
    text = candidate;
  }
  return text;
}

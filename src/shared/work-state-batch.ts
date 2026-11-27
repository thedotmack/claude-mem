/**
 * Pure argument check for the opt-in grouped form of `work_state_write`.
 * It runs once, before any POST: an entry the worker would refuse therefore
 * stops the whole batch before the first write. A worker failure *during* the
 * loop is not covered here — grouped writes are non-transactional by design.
 */
import type { WorkStateFields } from '../services/sqlite/work-state.js';
import { isSharedWorkList } from '../services/work-view/shared-records.mjs';
import { isMyRulesList } from '../services/work-view/my-rules.mjs';
import { isMyFocusList } from '../services/work-view/my-focus.mjs';
import { isOwnerGoalsList } from '../services/work-view/owner-goals.mjs';
import { isWorkStateFields, ownerGoalsRowRefusal } from './work-state-fields.js';

export const MAX_WORK_STATE_WRITE_ITEMS = 25;

/** One fixed message for every refusal, with no argument values in it. */
export const WORK_STATE_WRITE_ARGS_ERROR = 'Invalid work_state_write arguments: pass a non-empty list and exactly one of fields (a scalar-key object) or items (1-25 such objects).';

export type ParsedWorkStateWrite =
  | { kind: 'single'; fields: WorkStateFields }
  | { kind: 'batch'; items: WorkStateFields[] }
  | { kind: 'error'; message: string };

const error = (): ParsedWorkStateWrite => ({ kind: 'error', message: WORK_STATE_WRITE_ARGS_ERROR });

function validEntry(value: unknown): value is WorkStateFields {
  if (!isWorkStateFields(value)) return false;
  const task = (value as WorkStateFields).task;
  return !(typeof task === 'string' && task.trim().length === 0);
}

/**
 * `{list, fields}` keeps the shipped single-entry shape; `{list, items:[…]}`
 * groups up to 25 entries. Anything else is refused before a caller can POST.
 */
export function parseWorkStateWriteArgs(args: unknown): ParsedWorkStateWrite {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return error();
  const record = args as Record<string, unknown>;
  const list = record.list;
  if (typeof list !== 'string' || list.trim().length === 0 || list.trim().length > 200) return error();

  // Decide both list rules once, rather than per entry inside the caller's loop.
  // Mirror every list the worker refuses before any POST: the shared-records
  // prefix plus My Rules and My Focus (403 in WorkStateRoutes.handleWrite).
  const reserved = isSharedWorkList(list) || isMyRulesList(list) || isMyFocusList(list);
  const ownerGoals = isOwnerGoalsList(list);
  if (reserved) return error();

  const hasFields = Object.hasOwn(record, 'fields');
  const hasItems = Object.hasOwn(record, 'items');
  if (hasFields === hasItems) return error();

  if (hasFields) {
    if (!validEntry(record.fields)) return error();
    if (ownerGoals && ownerGoalsRowRefusal(record.fields)) return error();
    return { kind: 'single', fields: record.fields };
  }

  const items = record.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_WORK_STATE_WRITE_ITEMS) return error();
  for (const item of items) {
    if (!validEntry(item)) return error();
    if (ownerGoals && ownerGoalsRowRefusal(item)) return error();
  }
  return { kind: 'batch', items: items as WorkStateFields[] };
}

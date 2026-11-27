/**
 * The one definition of a storable work-state field map, shared by the worker's
 * HTTP schema and the MCP-side grouped-write helper. No zod here: this module
 * must stay safe to import from the MCP server bundle.
 */
import type { WorkStateFields } from '../services/sqlite/work-state.js';
import { MAX_WORK_STATE_FIELDS_JSON_CHARS } from '../services/work-view/work-state-limits.mjs';
import { GOAL_KINDS } from '../services/work-view/owner-goals.mjs';
import { isClosedWorkStateStatus } from '../services/work-view/work-state-status.mjs';

export { MAX_WORK_STATE_FIELDS_JSON_CHARS };

/**
 * Shape check only, so callers that need a different error per rule (the worker
 * distinguishes "empty" from "too long") can keep their own messages while the
 * value rules live in one place. z.record drops `__proto__`; every field is a
 * primitive, so this validates own entries and the schema copies with a spread.
 */
export function isWorkStateFieldValueMap(value: unknown): value is WorkStateFields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, field]) => key.length > 0 && (
      field === null || typeof field === 'string' || typeof field === 'boolean'
      // An integer past 2^53 cannot cross cloud sync's canonical JSON
      // (CanonicalContent), so refuse it here instead of quarantining it later.
      || (typeof field === 'number' && Number.isFinite(field) && (!Number.isInteger(field) || Number.isSafeInteger(field)))
    ));
}

/** The full rule the worker enforces and a grouped write must apply to every entry. */
export function isWorkStateFields(value: unknown): value is WorkStateFields {
  return isWorkStateFieldValueMap(value)
    && Object.keys(value).length > 0
    && JSON.stringify(value).length <= MAX_WORK_STATE_FIELDS_JSON_CHARS;
}

/** Why an owner-goals row cannot be saved, or null. List state rows and a row that only closes an item need no kind. */
export function ownerGoalsRowRefusal(fields: WorkStateFields): string | null {
  if (fields.task == null || fields.task === '') return null;
  const onlyCloses = Object.keys(fields).every(key => key === 'task' || key === 'status') && isClosedWorkStateStatus(fields.status);
  if (onlyCloses && !('goal_kind' in fields)) return null;
  if (!(GOAL_KINDS as unknown[]).includes(fields.goal_kind)) {
    return `an owner-goals item needs goal_kind ${GOAL_KINDS.map(kind => `"${kind}"`).join(' or ')}; got ${JSON.stringify(fields.goal_kind ?? null)}.`;
  }
  return null;
}

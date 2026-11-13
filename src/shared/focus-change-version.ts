import type { FocusArea } from '../services/work-view/my-focus.mjs';

/** What the owner can do to My Focus (POST /api/work-view/focus). One list: the route's check and the page's type take it. */
export const FOCUS_ACTIONS = ['keep', 'rename', 'edit-goal', 'edit-notes', 'set-initiative', 'merge', 'dismiss', 'done', 'reorder', 'move-request', 'restore-suggestion'] as const;
export type FocusAction = (typeof FOCUS_ACTIONS)[number];

type VersionArea = Pick<FocusArea, 'name' | 'goal' | 'status' | 'ownerRank' | 'priorityRank' | 'source' | 'mergedInto'>
  & { about?: string | null; notes?: string | null; initiative?: string | null; initiativeGuess?: boolean; initiativeNone?: boolean } & ({ id: string } | { focusAreaId: string });
interface VersionRequest { id: string; focusAreaId?: string }
interface FocusChangeTarget { action: string; focusAreaId?: string; focusAreaIds?: readonly string[]; requestId?: string }

export const FOCUS_CHANGED_MESSAGE = 'This focus changed since your edit. Review its current version before changing it again.';

const areaId = (area: VersionArea): string => 'id' in area ? area.id : area.focusAreaId;

/** The saved fields one focus write can replace; UI clocks and unrelated activity are not versions. */
export function focusChangeVersion(change: FocusChangeTarget, areas: readonly VersionArea[], requests: readonly VersionRequest[]): string | null {
  // The order covers the kept areas, and a suggestion the same write keeps by listing it: its status is part of what is replaced.
  if (change.action === 'reorder') {
    const listed = new Set(change.focusAreaIds ?? []);
    const kept = areas.filter(area => !area.mergedInto && (area.status === 'kept' || (area.status === 'suggested' && listed.has(areaId(area)))))
      .map(area => [areaId(area), area.status, area.ownerRank, area.priorityRank] as const)
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return JSON.stringify(kept);
  }
  if (change.action === 'move-request') {
    const request = requests.find(request => request.id === change.requestId);
    return request ? JSON.stringify([request.id, request.focusAreaId ?? null]) : null;
  }
  // An initiative is a row of its own per area (my-focus.mjs focusInitiativeRowFields); a guess is not the owner's and is no version.
  // Filed under none (false) is the owner's and differs from never filed (null).
  if (change.action === 'set-initiative') {
    const ids = [...(change.focusAreaIds ?? [])].sort();
    const owned = ids.map(id => areas.find(area => areaId(area) === id)).map(area => area ? [areaId(area), area.initiativeNone ? false : area.initiativeGuess ? null : area.initiative ?? null] : null);
    return owned.length && owned.every(Boolean) ? JSON.stringify(['initiative', ...owned]) : null;
  }
  const area = areas.find(area => areaId(area) === change.focusAreaId);
  // Notes are a row of their own (my-focus.mjs focusNotesRowFields): only edit-notes replaces it, and it replaces nothing else.
  if (change.action === 'edit-notes') return area ? JSON.stringify([areaId(area), 'notes', area.notes || null]) : null;
  return area ? JSON.stringify([areaId(area), area.name, area.goal, area.about ?? null, area.status,
    area.ownerRank, area.priorityRank, area.source, area.mergedInto]) : null;
}

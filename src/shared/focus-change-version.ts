import type { FocusArea } from '../services/work-view/my-focus.mjs';

/** A sub focus as the worker serves it (subFocusId) or My Work's model holds it (id). */
type VersionSubFocus = { name: string } & ({ id: string } | { subFocusId: string });
type VersionArea = Pick<FocusArea, 'name' | 'goal' | 'status' | 'ownerRank' | 'priorityRank' | 'source' | 'mergedInto'>
  & { about?: string | null; subFocuses?: readonly VersionSubFocus[] } & ({ id: string } | { focusAreaId: string });
interface VersionRequest { id: string; focusAreaId?: string; subFocusId?: string }
interface FocusChangeTarget { action: string; focusAreaId?: string; requestId?: string; subFocusId?: string | null }

export const FOCUS_CHANGED_MESSAGE = 'This focus changed since your edit. Review its current version before changing it again.';

const areaId = (area: VersionArea): string => 'id' in area ? area.id : area.focusAreaId;
const subFocusId = (subFocus: VersionSubFocus): string => 'id' in subFocus ? subFocus.id : subFocus.subFocusId;

/** The saved fields one focus write can replace; UI clocks and unrelated activity are not versions. */
export function focusChangeVersion(change: FocusChangeTarget, areas: readonly VersionArea[], requests: readonly VersionRequest[]): string | null {
  if (change.action === 'reorder') {
    const kept = areas.filter(area => area.status === 'kept' && !area.mergedInto)
      .map(area => [areaId(area), area.ownerRank, area.priorityRank] as const)
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return JSON.stringify(kept);
  }
  if (change.action === 'move-request') {
    const request = requests.find(request => request.id === change.requestId);
    return request ? JSON.stringify([request.id, request.focusAreaId ?? null]) : null;
  }
  if (change.action === 'move-to-sub-focus') {
    const request = requests.find(request => request.id === change.requestId);
    return request ? JSON.stringify([request.id, request.focusAreaId ?? null, request.subFocusId ?? null]) : null;
  }
  if (change.action === 'rename-sub-focus' || change.action === 'merge-sub-focus') {
    for (const area of areas) {
      const subFocus = area.subFocuses?.find(entry => subFocusId(entry) === change.subFocusId);
      if (subFocus) return JSON.stringify([subFocusId(subFocus), subFocus.name, areaId(area)]);
    }
    return null;
  }
  const area = areas.find(area => areaId(area) === change.focusAreaId);
  return area ? JSON.stringify([areaId(area), area.name, area.goal, area.about ?? null, area.status,
    area.ownerRank, area.priorityRank, area.source, area.mergedInto]) : null;
}

import type { FocusArea } from '../services/work-view/my-focus.mjs';

type VersionArea = Pick<FocusArea, 'name' | 'goal' | 'status' | 'ownerRank' | 'priorityRank' | 'source' | 'mergedInto'>
  & { about?: string | null } & ({ id: string } | { focusAreaId: string });
interface VersionRequest { id: string; focusAreaId?: string }
interface FocusChangeTarget { action: string; focusAreaId?: string; requestId?: string }

export const FOCUS_CHANGED_MESSAGE = 'This focus changed since your edit. Review its current version before changing it again.';

const areaId = (area: VersionArea): string => 'id' in area ? area.id : area.focusAreaId;

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
  const area = areas.find(area => areaId(area) === change.focusAreaId);
  return area ? JSON.stringify([areaId(area), area.name, area.goal, area.about ?? null, area.status,
    area.ownerRank, area.priorityRank, area.source, area.mergedInto]) : null;
}

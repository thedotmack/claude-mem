export const MY_FOCUS_LIST: 'my-focus';
export const OTHER_FOCUS_AREA_ID: 'other';
export type FocusAreaStatus = 'suggested' | 'kept' | 'dismissed' | 'done';
export type FocusAreaSource = 'owner-goals' | 'clustering' | 'promotion' | 'seed' | 'owner';
/** 'owner-restore': the owner handed a decided area back to the system. */
export type FocusAreaDecidedBy = 'owner' | 'system' | 'owner-restore';
export function isMyFocusList(name: unknown): boolean;
export interface FocusArea {
  focusAreaId: string; name: string; goal: string | null; status: FocusAreaStatus;
  priorityRank: number | null; ownerRank: number | null; source: FocusAreaSource;
  mergedInto: string | null; evidence: string | null; decidedBy: FocusAreaDecidedBy; savedAt: string | null;
}
export function focusAreaRowFields(area: Omit<FocusArea, 'savedAt'>): Record<string, string | number | null>;
export function placementRowFields(placement: {
  anchorConversationKey: string; focusAreaId: string; placedBy: 'router' | 'owner'; confidence?: number | null; evidence?: string | null;
}): Record<string, string | number | null>;
export function newFocusAreaId(): string;
export interface MinedFocusArea { name: string; goal: string; rank: number; matches: string | null; evidence: string }
export function ownerGoalsAreaRows(minedAreas: MinedFocusArea[], savedAreas: FocusArea[], newId?: (index: number) => string): {
  rows: Array<Record<string, string | number | null>>; focusAreaIds: string[];
};
export function buildFocusAreas(state: unknown): { focusAreas: FocusArea[]; focusAreaIdByAnchor: Map<string, string> };
export function anchorConversationKeyFor(request: { groupId?: string | null; conversationKey?: string | null }, ledger: unknown): string | null;
export function placeRequests<T extends { groupId?: string | null; conversationKey?: string | null }>(
  humanRequests: T[], focusAreaIdByAnchor: Map<string, string>, ledger: unknown,
): Array<T & { anchorConversationKey: string | null; focusAreaId?: string }>;

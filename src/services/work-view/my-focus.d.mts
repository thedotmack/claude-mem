export const MY_FOCUS_LIST: 'my-focus';
export const OTHER_FOCUS_AREA_ID: 'other';
export type FocusAreaStatus = 'suggested' | 'kept' | 'dismissed' | 'done';
export type FocusAreaSource = 'owner-goals' | 'clustering' | 'promotion' | 'seed' | 'owner';
/** 'owner-restore': the owner handed a decided area back to the system. */
export type FocusAreaDecidedBy = 'owner' | 'system' | 'owner-restore';
export function isMyFocusList(name: unknown): boolean;
export interface FocusArea {
  focusAreaId: string; name: string; goal: string | null;
  /** What belongs in the area, beyond its goal sentence; null when it was never written. */
  about: string | null; status: FocusAreaStatus;
  priorityRank: number | null; ownerRank: number | null; source: FocusAreaSource;
  mergedInto: string | null; evidence: string | null; decidedBy: FocusAreaDecidedBy; savedAt: string | null;
}
export function focusAreaRowFields(area: Omit<FocusArea, 'savedAt' | 'about'> & { about?: string | null }): Record<string, string | number | null>;
export function placementRowFields(placement: {
  anchorConversationKey: string; focusAreaId: string; placedBy: 'router' | 'owner'; confidence?: number | null; basis?: string | null; evidence?: string | null;
}): Record<string, string | number | null>;
export function newFocusAreaId(): string;
export interface MinedFocusArea { name: string; goal: string; rank: number; matches: string | null; evidence: string }
export function ownerGoalsAreaRows(minedAreas: MinedFocusArea[], savedAreas: FocusArea[], newId?: (index: number) => string): {
  rows: Array<Record<string, string | number | null>>; focusAreaIds: string[];
};
export interface PlacementSide { focusAreaId: string; basis: string | null; evidence: string | null; device: string | null }
export function buildFocusAreas(state: unknown, options?: { localDeviceId?: string | null }): {
  focusAreas: FocusArea[]; focusAreaIdByAnchor: Map<string, string>;
  placementsByAnchor: Map<string, { owner: PlacementSide | null; router: PlacementSide | null }>;
  /** The live area an id lands in, following merges; 'other' for Other; null when it holds no requests. */
  resolveFocusAreaId: (focusAreaId: string) => string | null;
  /** Which router-placed Other requests the last proposal pass looked at (hash), or null before the first pass. */
  otherPassHash: string | null;
};
export const PROPOSAL_SOURCES: Readonly<{ new: 'clustering'; promote: 'promotion' }>;
export const PROPOSAL_KINDS: ReadonlyArray<'new' | 'promote'>;
type FocusDatabase = { prepare(sql: string): { all(...params: unknown[]): any[] } };
/** localDeviceId is required: the worker's sync device id, '' when cloud sync never started. */
export function readFocus(database: FocusDatabase, options: { localDeviceId: string }): ReturnType<typeof buildFocusAreas>;
export function readFocusAreas(database: FocusDatabase, options: { localDeviceId: string }): FocusArea[];
export function isPlaceableArea(area: Pick<FocusArea, 'status' | 'mergedInto'>): boolean;
/** One record-focus answer as the worker writes it (POST /api/work-view/focus/router). */
export interface RouterFocusBody {
  /** confidence: the focus judge's probability, set on a placement it made without the agent. */
  placements: Array<{ anchorConversationKey: string; focusAreaId: string; basis: string; evidence: string; confidence?: number | null }>;
  proposals: Array<{
    kind: 'new' | 'promote'; name: string; goal: string; about: string; evidence: string;
    /** A placeable area this proposal already is (its requests go there), or null for a new suggested area. */
    sameAs: string | null;
    requests: Array<{ anchorConversationKey: string; basis: string }>;
  }>;
  /** Set after a pass over Other: the Other requests that pass looked at. */
  otherPassHash?: string | null;
}
export function routerFocusRows(body: RouterFocusBody, savedAreas: FocusArea[], newId?: (index: number) => string): {
  rows: Array<Record<string, string | number | null>>; focusAreaIds: string[]; placed: number;
};
export function anchorConversationKeyFor(request: { groupId?: string | null; conversationKey?: string | null }, ledger: unknown): string | null;
export function placeRequests<T extends { groupId?: string | null; conversationKey?: string | null }>(
  humanRequests: T[], focusAreaIdByAnchor: Map<string, string>, ledger: unknown,
): Array<T & { anchorConversationKey: string | null; focusAreaId?: string }>;
export function isOwnerDismissedArea(area: Pick<FocusArea, 'status' | 'decidedBy'>): boolean;
export function isWithdrawnArea(area: Pick<FocusArea, 'status' | 'decidedBy'>): boolean;
export const SEED_EVIDENCE_PREFIX: 'Seed: ';
/** The nav label an area name reuses as whole words, or null (nav-words.mjs). */
export { navWordIn } from './nav-words.mjs';
/** Throws a TypeError naming the nav word when a new area name reuses one. */
export function refuseNavWordName(name: string, label: string): void;
export function clearedPlacementRowFields(anchorConversationKey: string, evidence: string): Record<string, string | number | null>;
type FocusState = Pick<ReturnType<typeof buildFocusAreas>, 'focusAreas' | 'placementsByAnchor' | 'resolveFocusAreaId'>;
/** One seed (POST /api/work-view/focus/seed, action apply). */
export interface SeedFocusBody {
  areas: Array<{ key: string; name: string; goal: string; about: string; priorityRank: number; evidence: string; matches?: string | null }>;
  placements: Array<{ anchorConversationKey: string; area: string; confidence: number; basis: string; evidence: string }>;
}
export function seedFocusRows(seed: SeedFocusBody, focus: FocusState, newId?: (index: number) => string): {
  rows: Array<Record<string, string | number | null>>; focusAreaIds: Record<string, string>; created: string[];
  placed: Array<{ anchorConversationKey: string; focusAreaId: string; basis: string }>;
  skipped: Array<{ anchorConversationKey: string; placedBy: 'owner' | 'router'; focusAreaId: string }>;
};
/** What one seed wrote, from its note (POST /api/work-view/focus/seed, action undo). */
export interface SeedUndoBody { focusAreaIds: string[]; placements: Array<{ anchorConversationKey: string; focusAreaId: string; basis: string }> }
export function seedUndoRows(note: SeedUndoBody, focus: FocusState): {
  rows: Array<Record<string, string | number | null>>; withdrawn: string[]; leftByOwner: string[];
  /** Seed areas the owner never decided but uses (an owner placement lands in them, or an owner merge targets them). */
  leftInOwnerUse: string[]; alreadyWithdrawn: string[];
  cleared: string[]; replaced: string[];
  /** Seed placements left in an area the owner decided or uses. */
  leftInOwnerArea: string[];
};

export * from './focus-initiative-names.mjs';
/** A project key as the board names it (its root, never a folder path), or null when it names nothing. */
export function projectDisplayName(project: unknown, rootOf?: (project: unknown) => string | null): string | null;
/** What withFocusInitiatives adds to an area. */
export interface FocusInitiativeFields {
  /** The initiative the board shows: the owner's assignment, else the guess, else null or absent. */
  initiative?: string | null;
  /** Set when `initiative` is the guess from the area's folders, not the owner's assignment. */
  initiativeGuess?: true;
  /** The folders the area's requests ran in, most used first. Absent when none is known. */
  folders?: string[];
}
/** Each area with the initiative the board shows, whether it is a guess, and its folder names. */
export function withFocusInitiatives<Area extends { focusAreaId: string; initiative?: string | null; initiativeNone?: true }>(
  focusAreas: readonly Area[],
  humanRequests: ReadonlyArray<{ focusAreaId?: string; projects?: readonly string[]; updatedAtEpoch?: number | null }>,
  rootOf?: (project: unknown) => string | null,
): Array<Area & FocusInitiativeFields>;

// The initiative a focus area sits under when the board is arranged by initiative: the owner's own assignment
// (an "Initiative:" row in my-focus.mjs), else a guess read off the folders the area's requests ran in.
// The guess is only where the owner starts; it never replaces an assignment.
import { projectRoot } from './session-project.mjs';
import { MAX_FOCUS_INITIATIVE_CHARS, initiativeKey } from './focus-initiative-names.mjs';

export * from './focus-initiative-names.mjs';

/** How many folder names an area carries for the plan's input. */
const MAX_FOLDERS = 4;

/** A project key as the board names it: its root, so a repo's worktrees are one folder. Never a folder path. */
export function projectDisplayName(project, rootOf = projectRoot) {
  const root = rootOf(project);
  if (typeof root !== 'string') return null;
  const name = /^([/\\~]|[A-Za-z]:[/\\])/.test(root) ? root.split(/[/\\]/).filter(Boolean).at(-1) ?? '' : root;
  return name.trim().slice(0, MAX_FOCUS_INITIATIVE_CHARS).trim() || null;
}

/**
 * Each area with its initiative. `area.initiative` coming in is the owner's assignment or null (buildFocusAreas);
 * going out it is the name the board shows, and `initiativeGuess: true` marks one the owner did not choose: the
 * folder most of the area's requests ran in (a tie goes to the most recent activity, then to the name that sorts
 * first). A guess that is an owner's initiative but for its case takes the owner's spelling, so both are one heading.
 * An area the owner filed under no initiative (`initiativeNone`) gets no guess.
 * `folders` are the area's folder names, most used first, for the plan. Requests are the placed ones.
 */
export function withFocusInitiatives(focusAreas, humanRequests, rootOf = projectRoot) {
  const tallies = new Map();
  for (const request of humanRequests) {
    if (!request.focusAreaId) continue;
    const names = new Set((request.projects ?? []).map((project) => projectDisplayName(project, rootOf)).filter(Boolean));
    if (!tallies.has(request.focusAreaId)) tallies.set(request.focusAreaId, new Map());
    const tally = tallies.get(request.focusAreaId);
    for (const name of names) {
      const entry = tally.get(name) ?? { requests: 0, latestEpoch: 0 };
      tally.set(name, { requests: entry.requests + 1, latestEpoch: Math.max(entry.latestEpoch, request.updatedAtEpoch ?? 0) });
    }
  }
  const owned = new Map(focusAreas.filter((area) => area.initiative).map((area) => [initiativeKey(area.initiative), area.initiative]));
  return focusAreas.map((area) => {
    const folders = [...(tallies.get(area.focusAreaId) ?? [])]
      .sort(([a, x], [b, y]) => y.requests - x.requests || y.latestEpoch - x.latestEpoch || a.localeCompare(b))
      .map(([name]) => name).slice(0, MAX_FOLDERS);
    const withFolders = folders.length ? { ...area, folders } : area;
    if (area.initiative || area.initiativeNone || !folders.length) return withFolders;
    return { ...withFolders, initiative: owned.get(initiativeKey(folders[0])) ?? folders[0], initiativeGuess: true };
  });
}

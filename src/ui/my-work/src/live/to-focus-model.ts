// My Focus from the snapshot: the my-focus areas (focusAreas), each request's placement (humanRequests[].focusAreaId),
// and the owner-goals words behind each area and ask. Pure, so `node --test` can load it; nothing is re-ranked by
// guesswork: the owner's order wins, then the suggested priority, the same order the worker sorts by (my-focus.mjs).
import { OTHER_FOCUS_AREA_ID, type FocusArea, type FocusAsk, type FocusChange, type Quote } from '../data.ts'
import type { WorkViewFocusArea } from './work-view-api-types.ts'

/** One owner-goals item (an area or an ask), already read by to-work-model's toGoalItem. */
export interface MinedGoalItem {
  id: string
  title: string
  /** The my-focus area it belongs to (an ask's area, or an area's own id); null when the run named none. */
  focusAreaId: string | null
  timesAsked: number
  latestAt: string
  quotes: Quote[]
}

const SORTING_LABEL = 'Sorting…'
const OTHER_LABEL = 'Other'

/** The owner's order first; areas they have not ordered follow by suggested priority, then by name. */
export const byFocusPriority = (a: FocusArea, b: FocusArea) =>
  (a.ownerRank ?? Infinity) - (b.ownerRank ?? Infinity) || (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity) || a.name.localeCompare(b.name)

/** An area a request can be moved into (the worker's isPlaceableArea): kept or suggested, not merged. */
export const isPlaceableFocusArea = (area: FocusArea) => (area.status === 'kept' || area.status === 'suggested') && !area.mergedInto

/**
 * The live area an id lands in, following merges (my-focus.mjs buildFocusAreas `resolve`). 'other' stays Other.
 * Null when the id is unknown, dismissed, or caught in a merge loop: the request then reads "Sorting…" until the
 * next refresh places it, never a guessed area.
 */
export function createFocusAreaResolver(areas: readonly FocusArea[]): (focusAreaId: string | null | undefined) => string | null {
  const byId = new Map(areas.map((area) => [area.id, area]))
  const resolved = new Map<string, string | null>()
  return (focusAreaId) => {
    if (!focusAreaId) return null
    if (focusAreaId === OTHER_FOCUS_AREA_ID) return OTHER_FOCUS_AREA_ID
    if (resolved.has(focusAreaId)) return resolved.get(focusAreaId)!
    const seen = new Set<string>()
    let id = focusAreaId
    let result: string | null = null
    while (!seen.has(id)) {
      if (resolved.has(id)) { result = resolved.get(id)!; break }
      seen.add(id)
      const area = byId.get(id)
      if (!area) break
      if (!area.mergedInto) { result = area.status !== 'dismissed' ? area.id : null; break }
      id = area.mergedInto
    }
    // Keep one lookup per placement or merge chain within this model, not one area map per request.
    for (const visited of seen) resolved.set(visited, result)
    return result
  }
}

export function resolveFocusAreaId(focusAreaId: string | null | undefined, areas: readonly FocusArea[]): string | null {
  return createFocusAreaResolver(areas)(focusAreaId)
}

/** What a Suggested card shows for an edit saved from its Rename / Merge dialog. A merge decides the suggestion: the card
 * says "Merged" and has its own Undo. A rename or a new goal leaves it undecided, so the shared change bar shows it,
 * with Undo back to the old name or goal. */
export const suggestionEditDecision = (change: FocusChange): 'merged' | null => change.action === 'merge' ? 'merged' : null

/** What an area chip reads: the area's name, "Other", or "Sorting…" when the request has no placement yet. */
export function focusAreaLabel(focusAreaId: string | undefined, areas: readonly FocusArea[]): string {
  const placed = resolveFocusAreaId(focusAreaId, areas)
  if (placed === OTHER_FOCUS_AREA_ID) return OTHER_LABEL
  return areas.find((area) => area.id === placed)?.name ?? SORTING_LABEL
}

const toAsk = (item: MinedGoalItem): FocusAsk => ({ id: item.id, title: item.title, timesAsked: item.timesAsked, latestAt: item.latestAt, quotes: item.quotes })
/** Prompt stamps are `MM-DD HH:MM`, `MM-DD` or '' (not recorded); as strings they sort in time order within a run. */
const newerStamp = (a: string, b: string) => (a > b ? a : b)

/**
 * The my-focus areas with the owner-goals words behind them. Every owner-goals area item lands on the live area its id
 * resolves to (following merges, like asks), and items landing on one area are combined: times asked add up, the
 * latest prompt is the newest, and the quotes are all kept, newest first, each once. Asks go under the live area they
 * name; asks with no live area go to Other.
 */
export function toFocusModel(raw: readonly WorkViewFocusArea[] | undefined, minedAreas: readonly MinedGoalItem[], minedAsks: readonly MinedGoalItem[]): { focusAreas: FocusArea[]; otherAsks: FocusAsk[] } {
  const areas: FocusArea[] = (raw ?? []).map((area) => ({
    id: area.focusAreaId, name: area.name, goal: area.goal, about: area.about ?? null, status: area.status,
    ownerRank: area.ownerRank, priorityRank: area.priorityRank, source: area.source,
    mergedInto: area.mergedInto, evidence: area.evidence, notes: area.notes ?? null,
    ...(area.initiative ? { initiative: area.initiative, ...(area.initiativeGuess ? { initiativeGuess: true as const } : {}) } : area.initiativeNone ? { initiativeNone: true as const } : {}), ...(area.icon ? { icon: area.icon } : {}), ...(area.iconRun ? { iconRun: area.iconRun } : {}),
    timesAsked: null, latestAt: null, quotes: [], asks: [],
  })).sort(byFocusPriority)
  const resolveArea = createFocusAreaResolver(areas)
  const byId = new Map(areas.map((area) => [area.id, area]))
  const liveArea = (focusAreaId: string | null) => {
    const placed = resolveArea(focusAreaId)
    return placed && placed !== OTHER_FOCUS_AREA_ID ? byId.get(placed) : undefined
  }
  for (const item of minedAreas) {
    const area = liveArea(item.focusAreaId)
    if (!area) continue
    area.timesAsked = (area.timesAsked ?? 0) + item.timesAsked
    area.latestAt = area.latestAt === null ? item.latestAt : newerStamp(area.latestAt, item.latestAt)
    const seen = new Set(area.quotes.map((quote) => `${quote.at}\u0000${quote.quote}`))
    area.quotes = [...area.quotes, ...item.quotes.filter((quote) => !seen.has(`${quote.at}\u0000${quote.quote}`))].sort((a, b) => b.at.localeCompare(a.at))
  }
  const otherAsks: FocusAsk[] = []
  for (const ask of minedAsks) {
    const area = liveArea(ask.focusAreaId)
    if (area) area.asks.push(toAsk(ask))
    else otherAsks.push(toAsk(ask))
  }
  return { focusAreas: areas, otherAsks }
}

// The thread list's order and sections. Recorded placement only, as in focus-overview.ts: a request with no live
// placement is listed as not sorted yet, never filed under a guessed area.
import { ATTENTION_ORDER, OTHER_FOCUS_AREA_ID, startedTimestamp, type FocusArea, type FocusChange, type Request } from '../data.ts'
import { initiativeKey } from '../../../../services/work-view/focus-initiative-names.mjs'
import { byFocusPriority, resolveFocusAreaId } from './to-focus-model.ts'
import { focusOverview } from './focus-overview.ts'
import { chatHref, requestChat } from './chat-links.ts'

/** A person's move first, whatever its state (a shipped request can still owe an approval), then what is moving, then the rest; newest first within a state. */
export function sortThreads(requests: readonly Request[]): Request[] {
  const onAgent = (request: Request) => request.next.who === 'human' ? 0 : 1
  return [...requests].sort((a, b) => onAgent(a) - onAgent(b) || ATTENTION_ORDER.indexOf(a.state) - ATTENTION_ORDER.indexOf(b.state) || startedTimestamp(b) - startedTimestamp(a))
}

/** `requests` is everything filed in the group, which its line counts; `rows` is the part of it the list shows. */
export type ThreadGroup =
  | { kind: 'area'; key: string; area: FocusArea; requests: Request[]; rows: Request[] }
  | { kind: 'other'; key: string; requests: Request[]; rows: Request[] }
  | { kind: 'sorting'; key: string; requests: Request[]; rows: Request[] }

/**
 * Every request once: under its focus area in priority order (kept, then suggested, then any other live
 * area such as one marked done), then Other, then the ones not sorted yet. A kept area is listed even with no
 * requests, since its line is where the owner reads its notes, plans it and moves it; any other empty group is left out.
 * `shows` picks the rows (the Open filter leaves out what rests in Done): a focus whose requests are all left out keeps
 * its line and its counts, while Other and not-sorted-yet are listed only with a row to show.
 */
export function threadGroups(areas: readonly FocusArea[], requests: readonly Request[], shows: (request: Request) => boolean = () => true): ThreadGroup[] {
  // Unfiltered: the overview's own default leaves closed requests out, and `shows` below is what picks the rows.
  const overview = focusOverview(areas, requests, () => true)
  const ranked = [...overview.areas, ...overview.suggested].map((row) => row.area)
  const rest = areas.filter((area) => !ranked.includes(area) && resolveFocusAreaId(area.id, areas) === area.id).sort(byFocusPriority)
  const inArea = (area: FocusArea) => requests.filter((request) => resolveFocusAreaId(request.focusAreaId, areas) === area.id)
  const filed = (members: readonly Request[]) => { const sorted = sortThreads(members); return { requests: sorted, rows: sorted.filter(shows) } }
  const groups: ThreadGroup[] = [
    ...[...ranked, ...rest].map((area): ThreadGroup => ({ kind: 'area', key: area.id, area, ...filed(inArea(area)) })),
    { kind: 'other', key: OTHER_FOCUS_AREA_ID, ...filed(overview.other) },
    { kind: 'sorting', key: 'not-sorted', ...filed(overview.sorting) },
  ]
  return groups.filter((group) => group.rows.length > 0 || (group.kind === 'area' && (group.requests.length > 0 || group.area.status === 'kept')))
}

/** How the focus list is laid out. One definition; the control's words are a Record over it (my-work.tsx). */
export const FOCUS_ARRANGEMENTS = ['priority', 'initiative'] as const
export type FocusArrangement = (typeof FOCUS_ARRANGEMENTS)[number]
/** A preference saved before the arrangement was renamed (2026-11-12) reads as what it became. */
const RENAMED_ARRANGEMENTS: Record<string, FocusArrangement> = { project: 'initiative' }
/** A saved arrangement as this version names it, or undefined for a value it does not know. */
export function savedFocusArrangement(saved: unknown): FocusArrangement | undefined {
  if (typeof saved !== 'string') return undefined
  return FOCUS_ARRANGEMENTS.find((value) => value === saved) ?? (Object.hasOwn(RENAMED_ARRANGEMENTS, saved) ? RENAMED_ARRANGEMENTS[saved] : undefined)
}

type AreaGroup = Extract<ThreadGroup, { kind: 'area' }>

/**
 * A run of focus lines under one heading. `plain` has no heading: the whole list by priority, or the groups that
 * are not focuses (Other, not sorted yet). An initiative is the owner's own heading; `guess` says nobody filed any
 * of its focuses there yet, so its name is only the folder their requests ran in.
 */
export type FocusSection =
  | { kind: 'plain'; key: string; groups: ThreadGroup[] }
  | { kind: 'initiative'; key: string; initiative: string; guess: boolean; groups: AreaGroup[] }
  | { kind: 'no-initiative'; key: string; groups: AreaGroup[] }
export type InitiativeSection = Exclude<FocusSection, { kind: 'plain' }>

/**
 * The groups as the arrangement lays them out. By initiative: one section per initiative, in the order of each
 * one's best-ranked focus, its focuses in priority order; then the focuses with none; then the rest.
 * `groups` is already in priority order (threadGroups), so first seen is best ranked. Names that differ only by
 * case are one initiative, spelled as the owner filed it.
 */
export function focusSections(groups: readonly ThreadGroup[], arrangement: FocusArrangement): FocusSection[] {
  if (arrangement === 'priority') return [{ kind: 'plain', key: 'priority', groups: [...groups] }]
  const byInitiative = new Map<string, AreaGroup[]>()
  const unfiled: AreaGroup[] = []
  const rest: ThreadGroup[] = []
  for (const group of groups) {
    if (group.kind !== 'area') rest.push(group)
    else if (!group.area.initiative) unfiled.push(group)
    else byInitiative.set(initiativeKey(group.area.initiative), [...(byInitiative.get(initiativeKey(group.area.initiative)) ?? []), group])
  }
  return [
    ...[...byInitiative].map(([key, members]): FocusSection => {
      const filed = members.find((group) => !group.area.initiativeGuess)
      return { kind: 'initiative', key: `initiative:${key}`, initiative: (filed ?? members[0]).area.initiative!, guess: !filed, groups: members }
    }),
    ...(unfiled.length ? [{ kind: 'no-initiative', key: 'no-initiative', groups: unfiled } as const] : []),
    ...(rest.length ? [{ kind: 'plain', key: 'rest', groups: rest } as const] : []),
  ]
}

/** `focusAreaIds` filed under `initiative`, as the owner's change; an empty name puts them back on the guess. */
export const fileUnderInitiative = (focusAreaIds: readonly string[], initiative: string): FocusChange => ({ action: 'set-initiative', focusAreaIds: [...focusAreaIds], initiative: initiative.trim() })
/** `focusAreaIds` filed under no heading, as the owner's change: it stays so whatever folders their requests ran in. */
export const fileUnderNone = (focusAreaIds: readonly string[]): FocusChange => ({ action: 'set-initiative', focusAreaIds: [...focusAreaIds], initiative: '', noInitiative: true })

/** A focus the list still shows somewhere: not merged away and not dismissed. */
const isLiveArea = (area: FocusArea) => !area.mergedInto && area.status !== 'dismissed'

/**
 * One heading merged into another: every live focus under `from` (also one the list is not showing, such as a done
 * focus with nothing open) is filed under `into` in one change. Null when both are the same heading or `from` holds nothing.
 */
export function mergeInitiatives(from: string, into: string, areas: readonly FocusArea[]): FocusChange | null {
  if (!into.trim() || initiativeKey(from) === initiativeKey(into)) return null
  const members = areas.filter((area) => isLiveArea(area) && initiativeKey(area.initiative) === initiativeKey(from)).map((area) => area.id)
  return members.length ? fileUnderInitiative(members, into) : null
}

/**
 * A heading renamed: every focus under it is filed under the new name in one change, which merges the section into
 * an initiative that already has that name. Null when there is nothing to save: no name, or the name it already has
 * with every focus already filed there by the owner.
 */
export function renameInitiative(section: InitiativeSection, name: string): FocusChange | null {
  const next = name.trim()
  if (!next) return null
  if (section.kind === 'initiative' && next === section.initiative && section.groups.every((group) => !group.area.initiativeGuess)) return null
  return fileUnderInitiative(section.groups.map((group) => group.key), next)
}

/**
 * One focus moved to another heading, by the menu or a drop: null when it already sits there. Moving to no heading
 * is the owner's filing too, so a focus with a folder guess leaves the guess and stays out.
 */
export function moveToInitiative(area: Pick<FocusArea, 'id' | 'initiative' | 'initiativeGuess'>, initiative: string | null): FocusChange | null {
  const next = initiative?.trim() ?? ''
  if (!next) return area.initiative ? fileUnderNone([area.id]) : null
  return initiativeKey(next) === initiativeKey(area.initiative) && !area.initiativeGuess ? null : fileUnderInitiative([area.id], next)
}

/** What a `set-initiative` change did, for the saved note. */
export type InitiativeChangeSummary =
  /** One focus filed under another heading. */
  | { kind: 'moved'; name: string; to: string }
  /** Filed under no heading. */
  | { kind: 'unfiled'; names: string[] }
  /** Every focus of a heading filed under a new name, or under a name another heading already has. */
  | { kind: 'renamed' | 'merged'; from: string; to: string }
  /** Several focuses filed under one heading (a plan's proposal). */
  | { kind: 'filed'; count: number; to: string }

/**
 * One `set-initiative` change read against the areas as they were before it: what to say, and the changes that put
 * every area back where the owner had it. An area that was on its guess goes back by clearing its filing, one the
 * owner had under no heading goes back there, and areas that shared an earlier filing go back in one change. Undo is null when the change names an area that is not there.
 * `heading` is the heading the owner renamed, when that is how the change was made.
 */
export function initiativeChange(change: Pick<FocusChange, 'focusAreaIds' | 'initiative'>, areas: readonly FocusArea[], heading?: string): { summary: InitiativeChangeSummary; undo: FocusChange[] | null } {
  const ids = change.focusAreaIds ?? []
  const filed = areas.filter((area) => ids.includes(area.id))
  const to = change.initiative?.trim() ?? ''
  const before = new Map<string, { ids: string[]; back: (ids: string[]) => FocusChange }>()
  for (const area of filed) {
    const [key, back] = area.initiativeNone ? ['none', fileUnderNone] as const
      : area.initiative && !area.initiativeGuess ? [`name:${area.initiative}`, (members: string[]) => fileUnderInitiative(members, area.initiative!)] as const
        : ['guess', (members: string[]) => fileUnderInitiative(members, '')] as const
    before.set(key, { ids: [...(before.get(key)?.ids ?? []), area.id], back })
  }
  const undo = filed.length === ids.length && ids.length > 0 ? [...before.values()].map((entry) => entry.back(entry.ids)) : null
  // Another focus already under that name, in any case: the heading joins it.
  const joins = areas.some((area) => !ids.includes(area.id) && isLiveArea(area) && initiativeKey(area.initiative) === initiativeKey(to))
  let summary: InitiativeChangeSummary
  if (!to) summary = { kind: 'unfiled', names: filed.map((area) => area.name) }
  else if (heading && initiativeKey(heading) !== initiativeKey(to)) summary = { kind: joins ? 'merged' : 'renamed', from: heading, to }
  else if (filed.length === 1) summary = { kind: 'moved', name: filed[0].name, to }
  else summary = { kind: 'filed', count: filed.length, to }
  return { summary, undo }
}

/** One place a request can be filed: a focus, or Other (`OTHER_FOCUS_AREA_ID`, which has no name of its own). */
export interface MoveChoice { id: string; name: string | null; suggested: boolean; current: boolean }

/**
 * Where a request can be moved, for its Move to focus control: the kept focuses in the owner's order, then the
 * suggested ones, then Other, with the place it is in now marked. Empty when the worker would refuse any move (the
 * request has no conversation to file it under) or there is nowhere else to put it.
 */
export function moveChoices(request: Pick<Request, 'focusAreaId' | 'canMoveFocus'>, areas: readonly FocusArea[]): MoveChoice[] {
  if (request.canMoveFocus === false) return []
  const current = resolveFocusAreaId(request.focusAreaId, areas)
  const overview = focusOverview(areas, [])
  const choices = [...overview.areas, ...overview.suggested].map(({ area }): MoveChoice => ({ id: area.id, name: area.name, suggested: area.status === 'suggested', current: area.id === current }))
  if (choices.length === 0) return []
  return [...choices, { id: OTHER_FOCUS_AREA_ID, name: null, suggested: false, current: current === OTHER_FOCUS_AREA_ID }]
}

/** `peers` with one of them moved to another place among them. Out of range, or not a peer: unchanged. */
export function movePeer(peers: readonly string[], id: string, to: number): string[] {
  const from = peers.indexOf(id)
  const moved = [...peers]
  if (from < 0 || to < 0 || to >= peers.length) return moved
  moved.splice(to, 0, ...moved.splice(from, 1))
  return moved
}

/**
 * The grip's keyboard move: Arrow Up or Arrow Down takes `id` one place among its peers. Null when the key is another
 * one, or the focus is already at that end (or is not a peer), so nothing is saved.
 */
export function gripKeyMove(key: string, peers: readonly string[], id: string): string[] | null {
  const step = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
  const to = peers.indexOf(id) + step
  return step === 0 || !peers.includes(id) || to < 0 || to >= peers.length ? null : movePeer(peers, id, to)
}

/**
 * The whole order after some of its ids (`peers`, in their new order) were rearranged among themselves: they take
 * the places they already held between them, so every other id stays exactly where it was. The owner's order is
 * saved whole, and this is how a move inside one initiative leaves the other initiatives' focuses alone.
 */
export function reorderWithin(order: readonly string[], peers: readonly string[]): string[] {
  const moving = new Set(peers)
  let next = 0
  return order.map((id) => moving.has(id) ? peers[next++] : id)
}

/** A focus the owner can put in their order: one they kept, or a suggestion, which a move keeps. */
export const isOrderable = (area: FocusArea) => (area.status === 'kept' || area.status === 'suggested') && !area.mergedInto

/**
 * The owner's whole order after `id` was moved among the lines of its section (`peers`, in their new order: kept and
 * suggested focuses together). A kept focus takes its new place among the kept ones, as in reorderWithin. A suggested
 * one joins the order, which keeps it: before the kept focus that now follows it, else after the one before it, else
 * last. Suggestions it only passed on the way stay suggestions and are left out. `order` is the kept focuses as saved.
 */
export function placeInOrder(order: readonly string[], peers: readonly string[], id: string): string[] {
  const kept = peers.filter((peer) => order.includes(peer))
  if (order.includes(id)) return reorderWithin(order, kept)
  if (!peers.includes(id)) return [...order]
  const after = peers.slice(peers.indexOf(id) + 1).find((peer) => order.includes(peer))
  const before = peers.slice(0, peers.indexOf(id)).reverse().find((peer) => order.includes(peer))
  const at = after !== undefined ? order.indexOf(after) : before !== undefined ? order.indexOf(before) + 1 : order.length
  return [...order.slice(0, at), id, ...order.slice(at)]
}

/** The suggestions a saved order keeps: the ids it lists that were not kept before it. */
export const keptByOrder = (focusAreaIds: readonly string[] | undefined, areas: readonly FocusArea[]): FocusArea[] =>
  areas.filter((area) => area.status === 'suggested' && !area.mergedInto && !!focusAreaIds?.includes(area.id))

/**
 * Whose move a human step is, as a name: null means the person reading ("You"). Only the team view names someone
 * else, and only when another person asked for the request.
 */
export function moveOwner(request: Pick<Request, 'askedBy'>, viewer: { team: boolean; name: string }): string | null {
  return viewer.team && request.askedBy !== viewer.name ? request.askedBy : null
}

/** What a person can do from a thread's row. One definition; the row's controls are a switch over it. */
export const THREAD_ACTIONS = ['none', 'mark-checked', 'open-request', 'answer-suggestion', 'open-chat'] as const
export type ThreadAction = (typeof THREAD_ACTIONS)[number]

/**
 * The row's action, from what the next step needs. A review is marked checked in place, unless its saved decision
 * needs reading first (unavailable or in conflict), which the request page handles. An approval of a grouping
 * suggestion is answered in place. Anything else a person owes is said in the chat itself: nothing here can deliver
 * a reply into an agent session.
 */
export function threadAction(request: Pick<Request, 'id' | 'next' | 'state' | 'review' | 'suggestion' | 'chat'>): ThreadAction {
  if (request.next.who !== 'human') return 'none'
  if (request.next.need === 'review') {
    return request.state === 'needs-check' && request.review?.available !== false && !request.review?.conflict ? 'mark-checked' : 'open-request'
  }
  if (request.next.need === 'approval' && request.suggestion) return 'answer-suggestion'
  return chatHref(requestChat(request)) !== undefined ? 'open-chat' : 'none'
}

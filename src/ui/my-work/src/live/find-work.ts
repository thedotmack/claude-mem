// Find work (design pass Phase 4; Codex D02, Claude D14): what the words typed in Find match among the work already
// loaded in the browser. Pure, with .ts imports, so `node --test` loads it. It asks nothing of the worker and never
// searches memory: Memory's own search is one link away (src/ui/app-places.ts memoryFindAddress).
import type { Request } from '../data.ts'
import { ruleInUse, type OwnerRule } from '../data-rules.ts'
import { focusOverview, type FocusOverviewRow } from './focus-overview.ts'
import type { WorkModel } from './work-data-source.ts'

/**
 * What a result opens, in the order the page shows its groups. The one definition: the page words each group in a
 * Record over it, and the tests take the order from here.
 */
export const FIND_RESULT_GROUPS = ['areas', 'requests', 'rules'] as const
export type FindResultGroup = (typeof FIND_RESULT_GROUPS)[number]

export interface FindResults {
  /** Kept areas in the owner's order, then suggested ones, each with every request placed in it (focusOverview). */
  areas: FocusOverviewRow[]
  /** In the order the work lists them. */
  requests: Request[]
  /** Rules in use (data-rules.ts ruleInUse). */
  rules: OwnerRule[]
}

/**
 * Whether `text` holds the typed words. Each word must appear (in any order), without regard to case, so "viewer sync"
 * finds "Keep the remote pro viewer in sync". Words are split on white space; none typed matches nothing.
 */
export function matchesWords(words: string, ...texts: (string | null | undefined)[]): boolean {
  const wanted = words.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (wanted.length === 0) return false
  const haystack = texts.filter(Boolean).join('\n').toLocaleLowerCase()
  return wanted.every((word) => haystack.includes(word))
}

/**
 * Every focus area (by name and goal), request (by title and summary) and rule in use (by its when and then) that
 * holds the typed words. Nothing is cut: each group says how many it found, and the page pages long ones.
 */
export function findWork(words: string, model: Pick<WorkModel, 'focusAreas' | 'requests' | 'rules'>): FindResults {
  const overview = focusOverview(model.focusAreas, model.requests)
  return {
    areas: [...overview.areas, ...overview.suggested].filter(({ area }) => matchesWords(words, area.name, area.goal)),
    requests: model.requests.filter((request) => matchesWords(words, request.title ?? request.resolvesTo?.title, request.summary)),
    rules: model.rules.filter((rule) => ruleInUse(rule) && matchesWords(words, rule.when, rule.then)),
  }
}

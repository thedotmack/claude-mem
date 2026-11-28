// The bar's places, in the order the bar shows them (My Work design pass, Phase 3: one look and one bar). One list for
// My Work's top bar and phone bottom bar, for the h1 of each place's page, and for My Work's page ids
// (src/shared/work-view-pages.ts takes them from here). No imports, so My Work, the viewer bundle (whose tsconfig cannot
// leave src/ui) and the worker can all load it.

/** My Work's places, in bar order. Each id is also its My Work page id (`?view=<id>`; `work` is the address with no view). */
export const MY_WORK_PLACE_IDS = ['work', 'focus', 'requests', 'review-stack', 'rules'] as const
export type MyWorkPlaceId = typeof MY_WORK_PLACE_IDS[number]

export interface MyWorkPlace {
  id: MyWorkPlaceId
  /**
   * English words, for the place in the bar and its page's h1. Each screen shows them through its t(), and every
   * catalog has them (tests/ui-i18n.test.ts).
   */
  label: string
  /** The phone bottom bar's words, where five full labels have no room. */
  shortLabel: string
  /** Where the place opens, from the worker's root (My Work is at `/`). */
  address: string
}

const MY_WORK_PLACE_WORDS: Record<MyWorkPlaceId, Omit<MyWorkPlace, 'id'>> = {
  work: { label: 'My Work', shortLabel: 'My Work', address: '/' },
  focus: { label: 'Focus areas', shortLabel: 'Focus', address: '/?view=focus' },
  requests: { label: 'Requests', shortLabel: 'Requests', address: '/?view=requests' },
  'review-stack': { label: 'Review Stack', shortLabel: 'Review', address: '/?view=review-stack' },
  rules: { label: 'My Rules', shortLabel: 'My Rules', address: '/?view=rules' },
}

/** One place, by its id. */
export const myWorkPlace = (id: MyWorkPlaceId): MyWorkPlace => ({ id, ...MY_WORK_PLACE_WORDS[id] })
export const MY_WORK_PLACES: readonly MyWorkPlace[] = MY_WORK_PLACE_IDS.map(myWorkPlace)

/**
 * Memory, the memory viewer: another page, so the bar draws its link apart from the places and never marks it as the
 * page shown. Its words go through t() like the places' (tests/ui-i18n.test.ts).
 */
export const MEMORY_PLACE = { label: 'Memory', address: '/viewer' } as const

/**
 * Memory's own pages that My Work links to: its settings (the Workspace page) and its search of loaded memories with
 * the words typed in Find work. The memory viewer opens its timeline for any address it does not read yet; reading
 * these two is design pass Phase 11's (`#/settings/<section>` and `#/?find=<words>`).
 */
export const MEMORY_SETTINGS_ADDRESS = `${MEMORY_PLACE.address}#/settings`
export const memoryFindAddress = (words: string): string => `${MEMORY_PLACE.address}#/?find=${encodeURIComponent(words)}`

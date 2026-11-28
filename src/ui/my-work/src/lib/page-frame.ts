// How each My Work page sits in the shell's frame (design pass Phase 4). The one definition: App.tsx draws each page
// with it, the bar's "…" reads which pages it leads to from it, and the tests take their pages from it. Plain, with
// .ts imports, so the tests load it.
import type { Section } from '../store/store-types.ts'

/**
 * `compact`: Codex's narrower column (Find work, Workspace, Machine and sync). `reviewLine`: the failure line goes under
 * the title when the last review failed (components/review-failed-line.tsx), on the pages that showed the refresh
 * banner before it (a focus area's page draws it in its own header); Machine and sync shows the review itself.
 * `crumb`: the page it was reached from, over its title.
 */
export interface PageFrame { compact?: true; reviewLine?: true; crumb?: Section }

export const PAGE_FRAME: Record<Section, PageFrame> = {
  work: { reviewLine: true },
  focus: { reviewLine: true },
  requests: { reviewLine: true },
  'build-story': { reviewLine: true },
  suggested: { reviewLine: true },
  'past-focus': { reviewLine: true },
  rules: { reviewLine: true },
  'review-stack': {},
  find: { compact: true },
  workspace: { compact: true },
  machine: { compact: true, crumb: 'workspace' },
}

/** Workspace and the pages reached from it (their crumb leads back to it): the bar's "…" is marked on each. */
export const underWorkspace = (section: Section) => section === 'workspace' || PAGE_FRAME[section].crumb === 'workspace'

// How each My Work page sits in the shell's frame (design pass Phase 4). The one definition: App.tsx draws each page
// with it, the bar's "…" reads which pages it leads to from it, and the tests take their pages from it. Plain, with
// .ts imports, so the tests load it.
import type { Section, ViewState } from '../store/store-types.ts'

/**
 * `compact`: Codex's narrower column (Requests, Find work, Workspace, Machine and sync). `reviewLine`: the failure line
 * goes under the title when the last review failed (components/review-failed-line.tsx), on the pages that showed the
 * refresh banner before it (a focus area's page draws it in its own header); Machine and sync shows the review itself.
 * `crumb`: the page it was reached from, over its title; `groupedCrumb`: the same while the page is grouped (`?by=`:
 * Requests by agent is reached from Requests' list, Codex's by-agent page). `headingFocusTarget`: the h1 is the view's
 * heading, where focus goes when what had it leaves the page (components/app-shell.tsx ShellFrame).
 */
export interface PageFrame { compact?: true; reviewLine?: true; crumb?: Section; groupedCrumb?: Section; headingFocusTarget?: true }

export const PAGE_FRAME: Record<Section, PageFrame> = {
  work: { reviewLine: true },
  focus: { reviewLine: true },
  requests: { compact: true, reviewLine: true, groupedCrumb: 'requests', headingFocusTarget: true },
  'build-story': { reviewLine: true },
  suggested: { reviewLine: true },
  'past-focus': { reviewLine: true },
  rules: { reviewLine: true },
  'review-stack': {},
  find: { compact: true },
  workspace: { compact: true },
  machine: { compact: true, crumb: 'workspace' },
}

/** The crumb over a page's title: its own, or while it is grouped its grouped one; none on most pages. */
export function crumbOf(view: Pick<ViewState, 'section' | 'requestsBy'>): Section | null {
  const frame = PAGE_FRAME[view.section]
  return frame.crumb ?? (view.requestsBy !== null ? frame.groupedCrumb ?? null : null)
}

/** Workspace and the pages reached from it (their crumb leads back to it): the bar's "…" is marked on each. */
export const underWorkspace = (section: Section) => section === 'workspace' || PAGE_FRAME[section].crumb === 'workspace'

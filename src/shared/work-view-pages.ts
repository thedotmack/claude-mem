import { MY_WORK_PLACE_IDS } from '../ui/app-places.ts'

/**
 * URL-backed destinations in My Work; the viewer and the worker validate the same page names. Every page: the bar's
 * places (src/ui/app-places.ts: My Work, Focus areas, Requests, Review Stack, My Rules), then the pages reached from
 * them. Suggested and Past focus are Focus areas' tabs (their old addresses keep working), Build story is reached from
 * Past focus, Workspace from the bar's "…", Machine and sync from Workspace, and Find from Find work.
 */
export const WORK_VIEW_SECTIONS = [...MY_WORK_PLACE_IDS, 'suggested', 'past-focus', 'build-story', 'workspace', 'machine', 'find'] as const
/** The views a usage count names: setup, then every page. The hosted viewer checks the same list (services/viewer-host/src/usage.ts). */
export const WORK_VIEW_USAGE_VIEWS = ['setup', ...WORK_VIEW_SECTIONS] as const

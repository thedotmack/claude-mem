/** URL-backed destinations in My Work. The viewer and the worker validate the same page names. */
export const WORK_VIEW_NAV_PAGES = ['work', 'review-stack', 'rules'] as const
export const WORK_VIEW_SECTIONS = [...WORK_VIEW_NAV_PAGES, 'suggested', 'past-focus'] as const
export const WORK_VIEW_USAGE_VIEWS = ['setup', ...WORK_VIEW_SECTIONS] as const

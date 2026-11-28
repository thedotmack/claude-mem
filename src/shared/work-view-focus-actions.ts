/** The owner's changes to My Focus that POST /api/work-view/focus takes. The worker's request check (WorkViewRoutes
 * focusBody) and My Work's FocusChange take this one list. */
export const WORK_VIEW_FOCUS_ACTIONS = [
  'keep', 'rename', 'edit-goal', 'merge', 'dismiss', 'done', 'reorder', 'move-request', 'restore-suggestion',
  'rename-sub-focus', 'merge-sub-focus', 'move-to-sub-focus',
] as const
export type WorkViewFocusAction = (typeof WORK_VIEW_FOCUS_ACTIONS)[number]

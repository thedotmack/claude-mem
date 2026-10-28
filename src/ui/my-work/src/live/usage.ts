// Usage counts for the viewer: which page it opened on and which page it switched to. They go to the worker's
// POST /api/work-view/usage (WorkViewRoutes.ts), which counts them through claude-mem's anonymous telemetry —
// the same consent gate and property whitelist as every other event (opt out with `npx claude-mem telemetry
// disable`, CLAUDE_MEM_TELEMETRY=0 or DO_NOT_TRACK). Only the page id travels: never a request, prompt,
// observation, file path or search text. The page itself loads no analytics SDK.
/** The viewer's closed page ids: setup plus App.tsx `View`. A focus area is My Work filtered to it, so it is `work`, never its name. */
export type UsageView = 'setup' | 'work' | 'rules' | 'suggested' | 'past-focus'
export type UsageReport = { event: 'opened'; view: UsageView } | { event: 'switched'; view: UsageView; previousView: UsageView }

const WORK_VIEW_USAGE_URL = '/api/work-view/usage'

/** The report for showing `view`: an open when no page was shown before, a switch otherwise. Showing the same page again is nothing to count. */
export function usageReport(view: UsageView, previousView: UsageView | null): UsageReport | null {
  if (previousView === null) return { event: 'opened', view }
  if (previousView === view) return null
  return { event: 'switched', view, previousView }
}

/** Fire-and-forget, like the worker's own telemetry: a worker that is unreachable or refuses the report changes nothing on screen. */
export function sendUsageReport(report: UsageReport | null): void {
  if (!report) return
  fetch(WORK_VIEW_USAGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), keepalive: true })
    .catch(() => undefined)
}

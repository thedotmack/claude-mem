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

/**
 * One open per document. `reportOpen`'s flag lives in the store closure, so a
 * new store (the effect re-ran because the action identity changed) would post
 * `{event:'opened'}` again. The live feed updates the store continuously; that
 * is the repeat. Switches are not deduped here — a real page change still counts.
 */
let documentOpened = false

export function resetDocumentUsageForTests(): void {
  documentOpened = false
}

/** What to POST for this report. `null` means the document already counted its open. */
export function usageRequestBody(report: UsageReport | null, hosted: boolean): unknown[] | null {
  if (!report) return null
  if (report.event !== 'opened') return [report]
  if (documentOpened) return null
  documentOpened = true
  // The hosted viewer has no worker telemetry (that process sets DO_NOT_TRACK).
  // The open and the pageview go to the host's own endpoint together, once.
  return hosted ? [{ event: 'pageview' }, report] : [report]
}

function postUsage(url: string, body: unknown): void {
  try {
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
      .catch(() => undefined)
  } catch {
    // A relative URL outside a browser throws before the promise exists.
  }
}

/** Fire-and-forget, like the worker's own telemetry: a worker that is unreachable or refuses the report changes nothing on screen. */
export function sendUsageReport(report: UsageReport | null): void {
  const bodies = usageRequestBody(report, false)
  if (!bodies) return
  for (const body of bodies) postUsage(WORK_VIEW_USAGE_URL, body)
}

/** Hosted viewer (work.cmem.ai): the gate's usage endpoint, not the worker. */
export function sendHostedUsage(report: UsageReport | null): void {
  const bodies = usageRequestBody(report, true)
  if (!bodies) return
  for (const body of bodies) postUsage('/api/viewer-usage', body)
}

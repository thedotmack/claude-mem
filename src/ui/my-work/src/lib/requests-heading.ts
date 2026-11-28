// Requests' h1 (design pass Phase 5): its status tab's title, or its grouping's. One definition, read by the loaded
// page (App.tsx) and by the loading and failed screens (components/app-bar.tsx usePageHeadingBeforeLoad), which read
// only where the person is, so both say the same before and after the work loads.
import type { Translate } from '@/components/bits'
import type { CardGroupId } from '@/live/card-groups'
import type { RequestsGrouping } from '@/store/slices/view-slice'

/** Requests' status tabs: All, then each of the boards' groups (live/card-groups.ts CARD_GROUPS; `?status=`). */
export type RequestsTab = CardGroupId | 'all'

/** Each status tab's title (Codex: "Working requests", "Idle requests"); All is the page's own. */
const STATUS_HEADING: Record<RequestsTab, (t: Translate) => string> = {
  all: (t) => t('All requests'),
  'needs-you': (t) => t('Requests that need you'),
  working: (t) => t('Working requests'),
  idle: (t) => t('Idle requests'),
  shipped: (t) => t('Shipped requests'),
}

/** Each grouping's title. */
const GROUPING_HEADING: Record<RequestsGrouping, (t: Translate) => string> = {
  agent: (t) => t('Requests by agent'),
}

/** Requests' h1: its grouping's, or its status tab's. */
export function requestsHeading(view: { requestsStatus: CardGroupId | null; requestsBy: RequestsGrouping | null }, t: Translate): string {
  return view.requestsBy ? GROUPING_HEADING[view.requestsBy](t) : STATUS_HEADING[view.requestsStatus ?? 'all'](t)
}

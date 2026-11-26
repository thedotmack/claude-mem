import { useRef, useState } from 'react'
import { sendHostedPlansViewed } from './usage'
import { useVisibleRefresh, VISIBLE_REFRESH_RETRY_MS } from './use-visible-refresh'
import {
  memorySyncedIn, nextOfferCheckAt, offerChoiceIn, workViewOffer, WORK_VIEW_OFFERS,
  type WorkViewOffer, type WorkViewOfferFacts,
} from './work-view-offers'

/** This browser's own record of each dismissed offer, as the Cloud Sync guide keeps its hidden state (localStorage). */
const dismissedKey = (offer: WorkViewOffer) => 'cmem-work-offer-dismissed-' + offer
/**
 * The worker's answer is durable (GET /api/setup/state `memorySynced`), but a hub rebuild clears acknowledgement
 * stamps until this computer pushes again, so the page keeps that it once saw a synced memory.
 */
const MEMORY_SYNCED_KEY = 'cmem-work-first-memory-synced'

function stored(key: string): boolean {
  try { return localStorage.getItem(key) !== null } catch { return false }
}
function store(key: string): void {
  try { localStorage.setItem(key, '1') } catch { /* The choice still holds on this open page. */ }
}
const readDismissed = () => new Set(WORK_VIEW_OFFERS.filter((offer) => stored(dismissedKey(offer))))

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

type OfferRead = Omit<WorkViewOfferFacts, 'cloudSyncConfigured'>

/**
 * The offer My Work shows on this computer, with its dismissal. Whether Cloud Sync runs comes from the live feed the
 * page already reads (`cloudSyncConfigured`, cloudSyncConfiguredIn); the setup choice and whether this computer's first
 * memory has synced come from one local read, GET /api/setup/state. Reading stops for good once no offer the person
 * has not dismissed can come due (nextOfferCheckAt). Only the local Work View asks. A read that fails keeps the facts
 * already read and tries again (useVisibleRefresh). When the live feed's Cloud Sync state changes, the next look is
 * worked out again from the facts already read (useVisibleRefresh `reschedule`), so Cloud Sync turned on after the page
 * opened starts the wait for the first synced memory, without a read of its own.
 */
export function useWorkViewOffer(enabled: boolean, cloudSyncConfigured: boolean | null): {
  offer: WorkViewOffer | null
  dismiss: () => void
  viewPlans: () => void
} {
  const [dismissed, setDismissed] = useState(readDismissed)
  const dismissedRef = useRef(dismissed)
  dismissedRef.current = dismissed
  const configuredRef = useRef(cloudSyncConfigured)
  configuredRef.current = cloudSyncConfigured
  const reading = enabled && WORK_VIEW_OFFERS.some((offer) => !dismissed.has(offer))

  const read = async (signal: AbortSignal): Promise<OfferRead> => {
    const state = await readJson('/api/setup/state', signal)
    if (memorySyncedIn(state)) store(MEMORY_SYNCED_KEY)
    return { choice: offerChoiceIn(state), memorySynced: stored(MEMORY_SYNCED_KEY), now: Date.now() }
  }
  const nextCheckAt = (value: OfferRead, now: number) =>
    nextOfferCheckAt({ ...value, cloudSyncConfigured: configuredRef.current, now }, dismissedRef.current)
  const last = useVisibleRefresh(reading, read, nextCheckAt, VISIBLE_REFRESH_RETRY_MS, cloudSyncConfigured)

  // The live feed's Cloud Sync state is read on every render, so a change shows without another worker read.
  const facts: WorkViewOfferFacts | null = last && { ...last, cloudSyncConfigured, now: Date.now() }
  const offer = reading && facts ? workViewOffer(facts, dismissed) : null
  const dismiss = () => {
    if (!offer) return
    store(dismissedKey(offer))
    setDismissed((current) => new Set([...current, offer]))
  }
  // Counted through the worker's usage route, which works after setup (usage.ts sendHostedPlansViewed).
  const viewPlans = () => { sendHostedPlansViewed(facts?.choice?.cloudSyncOffer) }
  return { offer, dismiss, viewPlans }
}

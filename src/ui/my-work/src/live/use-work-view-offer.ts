import { useRef, useState } from 'react'
import { reportHostedPlansViewed } from '../setup/setup-telemetry'
import { useVisibleRefresh } from './use-visible-refresh'
import {
  hostedOfferPossible, memorySyncedIn, nextOfferCheckAt, offerChoiceIn, workViewOffer, WORK_VIEW_OFFERS,
  type WorkViewOffer, type WorkViewOfferFacts,
} from './work-view-offers'

/** This browser's own record of each dismissed offer, as the Cloud Sync guide keeps its hidden state (localStorage). */
const dismissedKey = (offer: WorkViewOffer) => 'cmem-work-offer-dismissed-' + offer
/** The worker counts hub acknowledgements only since it last started, so the page keeps that it once saw one. */
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
 * page already reads (`cloudSyncConfigured`, cloudSyncConfiguredIn); the setup choice comes from GET /api/setup/state;
 * GET /api/sync/status is read only while the hosted offer still waits on the first synced memory. Reading stops for
 * good once no offer the person has not dismissed can come due (nextOfferCheckAt). Only the local Work View asks.
 * A read that fails keeps the facts already read and tries again (useVisibleRefresh).
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
    const choice = offerChoiceIn(await readJson('/api/setup/state', signal))
    if (!stored(MEMORY_SYNCED_KEY) && !dismissedRef.current.has('hosted') && hostedOfferPossible(choice) && configuredRef.current !== false) {
      if (memorySyncedIn(await readJson('/api/sync/status', signal))) store(MEMORY_SYNCED_KEY)
    }
    return { choice, memorySynced: stored(MEMORY_SYNCED_KEY), now: Date.now() }
  }
  const nextCheckAt = (value: OfferRead, now: number) =>
    nextOfferCheckAt({ ...value, cloudSyncConfigured: configuredRef.current, now }, dismissedRef.current)
  const last = useVisibleRefresh(reading, read, nextCheckAt)

  // The live feed's Cloud Sync state is read on every render, so a change shows without another worker read.
  const facts: WorkViewOfferFacts | null = last && { ...last, cloudSyncConfigured, now: Date.now() }
  const offer = reading && facts ? workViewOffer(facts, dismissed) : null
  const dismiss = () => {
    if (!offer) return
    store(dismissedKey(offer))
    setDismissed((current) => new Set([...current, offer]))
  }
  const viewPlans = () => { void reportHostedPlansViewed(facts?.choice?.cloudSyncOffer) }
  return { offer, dismiss, viewPlans }
}

// The two offers My Work shows on this computer once setup is behind the person, and the one rule for each.
// Setup itself no longer asks: the hosted offer waits until Cloud Sync has carried a memory, and the Cloud Sync offer
// waits a few days after someone chose to keep memory on this computer.
import { SETUP_BRANCHES, SETUP_CLOUD_SYNC_OFFERS, SETUP_MEMORY_BILLINGS, type SetupBranch, type SetupCloudSyncOffer, type SetupMemoryBilling } from '../../../../shared/setup-funnel.ts'
import { SYNC_VIEWER_SENTENCES, type SyncPresentation } from '../../../viewer/utils/sync-presentation.ts'

/**
 * The offers, one definition (state-machines.md): the banner's words are a Record over it.
 * `hosted`: memory writing on cmem.ai, for Cloud Sync customers who write memories with their own plan.
 * `cloud-sync`: Cloud Sync, for people who chose "This computer".
 */
export const WORK_VIEW_OFFERS = ['hosted', 'cloud-sync'] as const
export type WorkViewOffer = (typeof WORK_VIEW_OFFERS)[number]

/** How long after choosing "This computer" the Cloud Sync offer waits: three days. */
export const CLOUD_SYNC_OFFER_DELAY_MS = 3 * 24 * 60 * 60 * 1000
/** While only the first synced memory is missing for the hosted offer, look again this often (each look asks the hub). */
export const FIRST_SYNC_RECHECK_MS = 60_000

/** The storage choice setup kept, with what the offers need to know about this computer's plan. */
export interface WorkViewOfferChoice {
  branch: SetupBranch
  memoryBilling: SetupMemoryBilling
  chosenAt: string
  cloudSyncOffer?: SetupCloudSyncOffer
  /** The installer kept an existing CMEM Pro or Cloud Sync configuration (`go-kept-existing-pro`): no new checkout. */
  keptExistingPro: boolean
  /** The observer already writes memories on cmem.ai (GET /api/setup/state `hostedObserver`). */
  hostedObserver: boolean
}

/** What the offers depend on, read from the worker. */
export interface WorkViewOfferFacts {
  /** The storage choice setup kept (GET /api/setup/state `choice`); null when there is none. */
  choice: WorkViewOfferChoice | null
  /** Whether this worker runs with Cloud Sync (the live feed's sync state, cloudSyncConfiguredIn); null while unknown. */
  cloudSyncConfigured: boolean | null
  /** The sync hub has acknowledged at least one memory from this computer (memorySyncedIn). */
  memorySynced: boolean
  now: number
}

/** When the Cloud Sync offer becomes due, or null when the choice gives no time to count from. */
export function cloudSyncOfferDueAt(choice: WorkViewOfferFacts['choice']): number | null {
  if (!choice || choice.branch !== 'home') return null
  const chosenAt = Date.parse(choice.chosenAt)
  return Number.isFinite(chosenAt) ? chosenAt + CLOUD_SYNC_OFFER_DELAY_MS : null
}

/** A free local user: chose "This computer" three or more days ago and has no Cloud Sync. */
export function cloudSyncOfferDue(facts: WorkViewOfferFacts): boolean {
  const dueAt = cloudSyncOfferDueAt(facts.choice)
  return dueAt !== null && facts.now >= dueAt && facts.cloudSyncConfigured === false
}

/**
 * The people setup used to show the hosted offer to: new Cloud Sync customers who write memories with their own
 * provider. Not someone who kept an existing CMEM Pro or Cloud Sync plan, nor an observer already on cmem.ai.
 */
export function hostedOfferPossible(choice: WorkViewOfferFacts['choice']): boolean {
  return choice?.branch === 'go' && choice.memoryBilling === 'existing' && !choice.keptExistingPro && !choice.hostedObserver
}

/** The hosted offer, once Cloud Sync has carried the first memory. */
export function hostedOfferDue(facts: WorkViewOfferFacts): boolean {
  return hostedOfferPossible(facts.choice) && facts.cloudSyncConfigured === true && facts.memorySynced
}

const OFFER_DUE: Record<WorkViewOffer, (facts: WorkViewOfferFacts) => boolean> = {
  hosted: hostedOfferDue,
  'cloud-sync': cloudSyncOfferDue,
}

/** Whether an offer can ever come due for this choice, whatever Cloud Sync and the clock say later. */
const OFFER_POSSIBLE: Record<WorkViewOffer, (choice: WorkViewOfferChoice) => boolean> = {
  hosted: hostedOfferPossible,
  'cloud-sync': (choice) => cloudSyncOfferDueAt(choice) !== null,
}

/** The one offer to show now: the first that is due and that the person has not dismissed, or null. */
export function workViewOffer(facts: WorkViewOfferFacts, dismissed: ReadonlySet<WorkViewOffer>): WorkViewOffer | null {
  return WORK_VIEW_OFFERS.find((offer) => !dismissed.has(offer) && OFFER_DUE[offer](facts)) ?? null
}

/** Whether the hosted offer still waits on the first synced memory, which only GET /api/sync/status can show. */
export function waitingForFirstSync(facts: Omit<WorkViewOfferFacts, 'now'>, dismissed: ReadonlySet<WorkViewOffer>): boolean {
  return !dismissed.has('hosted') && hostedOfferPossible(facts.choice) && !facts.memorySynced && facts.cloudSyncConfigured !== false
}

/**
 * When Work View should read the worker again for the offers (built on the same rules as workViewOffer):
 * - `Infinity`: never. No offer the person has not dismissed can come due for this choice, so stop reading.
 * - a time: the Cloud Sync offer comes due then, or the hosted offer waits on the first memory (FIRST_SYNC_RECHECK_MS).
 * - null: nothing to wait for on a clock; read again when the page is shown (setup not chosen yet, or an offer is up).
 */
export function nextOfferCheckAt(facts: WorkViewOfferFacts, dismissed: ReadonlySet<WorkViewOffer>): number | null {
  const choice = facts.choice
  if (!choice) return null
  if (!WORK_VIEW_OFFERS.some((offer) => !dismissed.has(offer) && OFFER_POSSIBLE[offer](choice))) return Number.POSITIVE_INFINITY
  const times: number[] = []
  const dueAt = cloudSyncOfferDueAt(choice)
  if (!dismissed.has('cloud-sync') && dueAt !== null && dueAt > facts.now) times.push(dueAt)
  if (waitingForFirstSync(facts, dismissed)) times.push(facts.now + FIRST_SYNC_RECHECK_MS)
  return times.length > 0 ? Math.min(...times) : null
}

/**
 * Whether this worker runs with Cloud Sync, from the connection the live feed already reports (connection-status.ts):
 * `unconfigured` is off, a state the worker did not report is unknown, and any other state is on.
 */
export function cloudSyncConfiguredIn(sync: Pick<SyncPresentation, 'state' | 'detailParts'> | undefined): boolean | null {
  if (!sync) return null
  if (sync.state === 'unconfigured') return false
  if (sync.state === 'unknown' && sync.detailParts?.sentence === SYNC_VIEWER_SENTENCES.notReported) return null
  return true
}

/**
 * Whether GET /api/sync/status says the hub acknowledged a memory (an observation or a summary) from this computer.
 * The worker counts acknowledgements since it last started (CloudSync `queue.progress`), so the page also remembers
 * that it saw one (use-work-view-offer.ts). The hub's `headSeq` would survive a restart, but it counts every change
 * from every device of the account, prompts included, so it does not say that this computer's first memory synced.
 */
export function memorySyncedIn(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false
  const progress = (status as { queue?: { progress?: Record<string, { acknowledged?: unknown } | undefined> } }).queue?.progress
  return ['observation', 'summary'].some((kind) => {
    const acknowledged = progress?.[kind]?.acknowledged
    return typeof acknowledged === 'number' && acknowledged > 0
  })
}

/** The setup choice in GET /api/setup/state, when it has the fields the offers read. */
export function offerChoiceIn(state: unknown): WorkViewOfferFacts['choice'] {
  if (!state || typeof state !== 'object') return null
  const view = state as { choice?: unknown; installer?: { stage?: unknown } | null; hostedObserver?: unknown }
  const choice = view.choice
  if (!choice || typeof choice !== 'object') return null
  const { branch, memoryBilling, chosenAt, cloudSyncOffer } = choice as Record<string, unknown>
  if (!SETUP_BRANCHES.includes(branch as SetupBranch) || !SETUP_MEMORY_BILLINGS.includes(memoryBilling as SetupMemoryBilling)
    || typeof chosenAt !== 'string') return null
  return {
    branch: branch as SetupBranch, memoryBilling: memoryBilling as SetupMemoryBilling, chosenAt,
    ...(SETUP_CLOUD_SYNC_OFFERS.includes(cloudSyncOffer as SetupCloudSyncOffer) ? { cloudSyncOffer: cloudSyncOffer as SetupCloudSyncOffer } : {}),
    keptExistingPro: view.installer?.stage === 'go-kept-existing-pro',
    // An older worker does not say; it is not taken as hosted, as before.
    hostedObserver: view.hostedObserver === true,
  }
}

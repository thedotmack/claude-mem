// Run with `npm test`. When My Work offers hosted memory writing and Cloud Sync (onboarding fixes, Phase 3).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLOUD_SYNC_OFFER_DELAY_MS, cloudSyncConfiguredIn, cloudSyncOfferDue, cloudSyncOfferDueAt, FIRST_SYNC_RECHECK_MS, hostedOfferDue,
  memorySyncedIn, nextOfferCheckAt, offerChoiceIn, workViewOffer, type WorkViewOffer, type WorkViewOfferFacts,
} from './work-view-offers.ts'
import { presentSync, SYNC_VIEWER_SENTENCES } from '../../../viewer/utils/sync-presentation.ts'

const chosenAt = '2026-11-20T10:00:00.000Z'
const chosen = Date.parse(chosenAt)
const plain = { keptExistingPro: false, hostedObserver: false }
const home: WorkViewOfferFacts = { choice: { branch: 'home', memoryBilling: 'existing', chosenAt, ...plain }, cloudSyncConfigured: false, memorySynced: false, now: chosen + CLOUD_SYNC_OFFER_DELAY_MS }
const cloud: WorkViewOfferFacts = { choice: { branch: 'go', memoryBilling: 'existing', chosenAt, ...plain }, cloudSyncConfigured: true, memorySynced: true, now: chosen }
const none = new Set<never>()

describe('the Cloud Sync offer for free local users', () => {
  it('is due three days after choosing This computer, not a moment before', () => {
    assert.equal(CLOUD_SYNC_OFFER_DELAY_MS, 3 * 24 * 60 * 60 * 1000)
    assert.equal(cloudSyncOfferDueAt(home.choice), chosen + CLOUD_SYNC_OFFER_DELAY_MS)
    assert.equal(cloudSyncOfferDue(home), true)
    assert.equal(cloudSyncOfferDue({ ...home, now: home.now - 1 }), false)
    assert.equal(cloudSyncOfferDue({ ...home, now: home.now + 30 * 24 * 60 * 60 * 1000 }), true)
  })
  it('is not due with Cloud Sync, while Cloud Sync is unknown, or for anyone who did not choose This computer', () => {
    assert.equal(cloudSyncOfferDue({ ...home, cloudSyncConfigured: true }), false)
    assert.equal(cloudSyncOfferDue({ ...home, cloudSyncConfigured: null }), false)
    assert.equal(cloudSyncOfferDue({ ...home, choice: null }), false)
    assert.equal(cloudSyncOfferDue({ ...home, choice: { ...home.choice!, branch: 'go' }, cloudSyncConfigured: false }), false)
  })
  it('has no time to count from when the choice time cannot be read', () => {
    assert.equal(cloudSyncOfferDueAt({ ...home.choice!, chosenAt: 'yesterday' }), null)
    assert.equal(cloudSyncOfferDue({ ...home, choice: { ...home.choice!, chosenAt: '' } }), false)
  })
})

describe('the hosted offer after Cloud Sync', () => {
  it('is due once the first memory has synced for Cloud Sync with the person’s own provider', () => {
    assert.equal(hostedOfferDue(cloud), true)
    assert.equal(hostedOfferDue({ ...cloud, memorySynced: false }), false)
  })
  it('is not due without Cloud Sync, for hosted or local choices, or with no choice', () => {
    assert.equal(hostedOfferDue({ ...cloud, cloudSyncConfigured: false }), false)
    assert.equal(hostedOfferDue({ ...cloud, cloudSyncConfigured: null }), false)
    assert.equal(hostedOfferDue({ ...cloud, choice: { ...cloud.choice!, memoryBilling: 'hosted' } }), false)
    assert.equal(hostedOfferDue({ ...cloud, choice: { ...cloud.choice!, branch: 'home' } }), false)
    assert.equal(hostedOfferDue({ ...cloud, choice: null }), false)
  })
  it('is not due for someone who kept an existing plan, or whose observer already writes on cmem.ai', () => {
    assert.equal(hostedOfferDue({ ...cloud, choice: { ...cloud.choice!, keptExistingPro: true } }), false)
    assert.equal(hostedOfferDue({ ...cloud, choice: { ...cloud.choice!, hostedObserver: true } }), false)
    assert.equal(workViewOffer({ ...cloud, choice: { ...cloud.choice!, keptExistingPro: true } }, none), null)
  })
})

describe('the one offer shown', () => {
  it('shows the due offer until it is dismissed, and nothing when none is due', () => {
    assert.equal(workViewOffer(cloud, none), 'hosted')
    assert.equal(workViewOffer(cloud, new Set(['hosted'])), null)
    assert.equal(workViewOffer(home, none), 'cloud-sync')
    assert.equal(workViewOffer(home, new Set(['cloud-sync'])), null)
    // Dismissing one offer does not hide the other.
    assert.equal(workViewOffer(home, new Set(['hosted'])), 'cloud-sync')
    assert.equal(workViewOffer({ ...home, now: chosen }, none), null)
  })
  it('never has two offers due at once', () => {
    for (const facts of [home, cloud, { ...home, cloudSyncConfigured: true, memorySynced: true }, { ...cloud, cloudSyncConfigured: false }]) {
      assert.equal(hostedOfferDue(facts) && cloudSyncOfferDue(facts), false)
    }
  })
})

describe('reading the worker', () => {
  it('counts a hub acknowledgement of an observation or a summary as a synced memory', () => {
    const status = (observation: number, summary: number, prompt = 0) => ({ configured: true, queue: { progress: {
      observation: { acknowledged: observation, lastAcknowledgedAt: null }, summary: { acknowledged: summary, lastAcknowledgedAt: null },
      prompt: { acknowledged: prompt, lastAcknowledgedAt: null },
    } } })
    assert.equal(memorySyncedIn(status(1, 0)), true)
    assert.equal(memorySyncedIn(status(0, 2)), true)
    assert.equal(memorySyncedIn(status(0, 0, 5)), false)
    assert.equal(memorySyncedIn({ configured: false }), false)
    assert.equal(memorySyncedIn(null), false)
    assert.equal(memorySyncedIn({ queue: { progress: { observation: { acknowledged: '3' } } } }), false)
  })
  it('takes the setup choice only with a known branch, billing and choice time', () => {
    assert.deepEqual(offerChoiceIn({ status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt, usage: {} } }),
      { branch: 'home', memoryBilling: 'existing', chosenAt, ...plain })
    assert.deepEqual(offerChoiceIn({ choice: { branch: 'go', memoryBilling: 'existing', chosenAt, cloudSyncOffer: 'cloud_sync_annual' },
      installer: { stage: 'go-kept-existing-pro' }, hostedObserver: true }),
      { branch: 'go', memoryBilling: 'existing', chosenAt, cloudSyncOffer: 'cloud_sync_annual', keptExistingPro: true, hostedObserver: true })
    // An unknown plan is dropped, and an older worker that names neither flag reads as neither.
    assert.deepEqual(offerChoiceIn({ choice: { branch: 'go', memoryBilling: 'existing', chosenAt, cloudSyncOffer: 'lifetime' }, installer: null }),
      { branch: 'go', memoryBilling: 'existing', chosenAt, ...plain })
    assert.equal(offerChoiceIn({ choice: null }), null)
    assert.equal(offerChoiceIn({ choice: { branch: 'away', memoryBilling: 'existing', chosenAt } }), null)
    assert.equal(offerChoiceIn({ choice: { branch: 'go', memoryBilling: 'free', chosenAt } }), null)
    assert.equal(offerChoiceIn({ choice: { branch: 'go', memoryBilling: 'existing' } }), null)
    assert.equal(offerChoiceIn(null), null)
  })
})

describe('when to read the worker again', () => {
  const dismissed = (...offers: WorkViewOffer[]) => new Set<WorkViewOffer>(offers)
  it('stops for good when no offer the person has not dismissed can come due', () => {
    assert.equal(nextOfferCheckAt({ ...cloud, choice: { ...cloud.choice!, memoryBilling: 'hosted' } }, none), Infinity)
    assert.equal(nextOfferCheckAt({ ...cloud, choice: { ...cloud.choice!, keptExistingPro: true } }, none), Infinity)
    assert.equal(nextOfferCheckAt({ ...cloud, choice: { ...cloud.choice!, hostedObserver: true } }, none), Infinity)
    assert.equal(nextOfferCheckAt(cloud, dismissed('hosted')), Infinity)
    assert.equal(nextOfferCheckAt(home, dismissed('cloud-sync')), Infinity)
    assert.equal(nextOfferCheckAt({ ...home, choice: { ...home.choice!, chosenAt: 'yesterday' } }, none), Infinity)
  })
  it('wakes when the Cloud Sync offer comes due', () => {
    assert.equal(nextOfferCheckAt({ ...home, now: chosen }, none), chosen + CLOUD_SYNC_OFFER_DELAY_MS)
    // Already due (or shown): nothing left on a clock.
    assert.equal(nextOfferCheckAt(home, none), null)
  })
  it('looks again soon while the hosted offer waits on the first synced memory, unless Cloud Sync is off', () => {
    const waiting = { ...cloud, memorySynced: false }
    assert.equal(nextOfferCheckAt(waiting, none), cloud.now + FIRST_SYNC_RECHECK_MS)
    assert.equal(nextOfferCheckAt({ ...waiting, cloudSyncConfigured: null }, none), cloud.now + FIRST_SYNC_RECHECK_MS)
    assert.equal(nextOfferCheckAt({ ...waiting, cloudSyncConfigured: false }, none), null)
    assert.equal(nextOfferCheckAt(cloud, none), null)
  })
  it('waits for a choice that setup has not saved yet', () => {
    assert.equal(nextOfferCheckAt({ ...home, choice: null }, none), null)
  })
})

describe('Cloud Sync from the live feed', () => {
  const status = (configured: boolean) => ({ configured, state: configured ? 'current' as const : 'unconfigured' as const, mode: 'polling' as const,
    checkedAt: 1, observedAt: 1, message: configured ? 'Synced.' : 'Cloud sync is not configured.', download: { lastSuccessAt: 1 },
    projection: { remaining: null }, completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: null, scope: 'eligible' as const } })
  it('reads off from unconfigured, unknown while the worker has not reported, and on otherwise', () => {
    assert.equal(cloudSyncConfiguredIn(undefined), null)
    assert.equal(cloudSyncConfiguredIn(presentSync(null, null, 1)), null)
    assert.equal(presentSync(null, null, 1).detailParts?.sentence, SYNC_VIEWER_SENTENCES.notReported)
    assert.equal(cloudSyncConfiguredIn(presentSync(status(false), 1, 1)), false)
    assert.equal(cloudSyncConfiguredIn(presentSync(status(true), 1, 1)), true)
    // A configured worker whose freshness is not confirmed is still on.
    assert.equal(cloudSyncConfiguredIn(presentSync(status(true), null, 1)), true)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectSetupTelemetry, createSetupTracker, readSetupTelemetryContext, sendSetupEvent } from './setup-telemetry.ts'
import { parseSetupEvent, type SetupEvent } from '../../../../shared/setup-funnel.ts'

const flow = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function fixture() {
  let id = 0
  const sent: SetupEvent[] = []
  const tracker = createSetupTracker(async event => { sent.push(event) }, {
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => 1_800_000_000_000 + id,
  })
  return { tracker, sent }
}
const unknown = { branch: 'go' as const, branch_confirmed: false }
const home = { branch: 'home' as const, branch_confirmed: true }
const go = { branch: 'go' as const, branch_confirmed: true }

describe('actual setup screen telemetry', () => {
  it('retains early visits until the consented episode arrives, without inventing pageviews', async () => {
    const { tracker, sent } = fixture()
    tracker.view('scan', unknown)
    tracker.view('scan', unknown)
    tracker.view('reveal', unknown)
    assert.equal(sent.length, 0)
    tracker.start({ setup_flow_id: flow, already_pro: true })
    await tracker.flush()
    assert.deepEqual(sent.map(event => event.event), ['setup_step_viewed', 'setup_step_transitioned', 'setup_step_viewed'])
    assert.equal(sent[0].visit_id, sent[1].visit_id)
    assert.notEqual(sent[0].visit_id, sent[2].visit_id)
    assert.equal(sent[1].to_step, 'reveal')
    assert(sent.every(event => event.already_pro && event.setup_flow_id === flow && parseSetupEvent(event)))
  })
  it('does not emit for opt-out or a sample with no episode', async () => {
    const { tracker, sent } = fixture()
    tracker.view('scan', unknown)
    tracker.start(null)
    tracker.view('reveal', unknown)
    tracker.action('upload_skipped')
    await tracker.flush()
    assert.deepEqual(sent, [])
    assert.deepEqual(tracker.completionEvents(), [])
  })
  it('measures Home, existing Pro and reduced-motion skips as the actual next screen', async () => {
    for (const [branch, steps] of [
      [home, ['scan', 'reveal', 'choice', 'savings', 'finish-setup', 'workspace']],
      [go, ['scan', 'reveal', 'choice', 'savings', 'finish-setup', 'launch', 'workspace']],
    ] as const) {
      const { tracker, sent } = fixture()
      tracker.start({ setup_flow_id: flow, already_pro: branch === go })
      for (const step of steps) tracker.view(step, branch)
      await tracker.flush()
      assert(!sent.some(event => event.step === 'checkout'))
      assert.deepEqual(sent.filter(event => event.event === 'setup_step_viewed').map(event => event.step), steps)
      assert(sent.filter(event => event.event === 'setup_step_transitioned').every(event => event.direction === 'forward'))
    }
  })
  it('preserves a new visit on each return, and differentiates successful from failed imports', async () => {
    const { tracker, sent } = fixture()
    tracker.start({ setup_flow_id: flow, already_pro: false })
    tracker.view('checkout', go)
    tracker.view('savings', go)
    tracker.view('checkout', go)
    tracker.view('finish-setup', go)
    tracker.view('import', go)
    tracker.error('import_failed')
    tracker.error('import_failed')
    tracker.view('finish-setup', go)
    tracker.view('import', go)
    tracker.view('finish-setup', { ...go, importComplete: true })
    await tracker.flush()
    const transitions = sent.filter(event => event.event === 'setup_step_transitioned')
    assert.equal(transitions[0].direction, 'back')
    assert.notEqual(transitions[0].visit_id, transitions[2].visit_id)
    assert.deepEqual(transitions.filter(event => event.step === 'import').map(event => event.direction), ['back', 'forward'])
    assert.equal(sent.filter(event => event.event === 'setup_step_error').length, 1)
    assert.equal(new Set(transitions.map(event => event.visit_id)).size, transitions.length)
  })
  it('only confirms the actual choice and prepares completion for the successful worker write', async () => {
    const { tracker, sent } = fixture()
    tracker.start({ setup_flow_id: flow, already_pro: false })
    tracker.view('savings', unknown)
    tracker.error('choice_failed')
    tracker.action('choice_committed', home)
    tracker.view('finish-setup', home)
    tracker.view('workspace', home)
    await tracker.flush()
    const completion = tracker.completionEvents()
    assert.deepEqual(completion.map(event => event.event), ['setup_step_transitioned', 'setup_completed'])
    assert.equal(completion[0].to_step, 'complete')
    assert.equal(completion[0].visit_id, completion[1].visit_id)
    assert(completion.every(event => event.step === 'workspace' && parseSetupEvent(event)))
    tracker.complete()
    tracker.view('scan', unknown)
    assert.deepEqual(tracker.completionEvents(), [])
    await tracker.flush()
    assert.equal(sent.find(event => event.action === 'choice_committed')?.branch, 'home')
    assert.equal(sent.find(event => event.action === 'choice_committed')?.branch_confirmed, true)
    assert(!sent.some(event => event.event === 'setup_completed'))
  })
  it('a hidden tab neither exits a visit nor creates another one', async () => {
    const { tracker, sent } = fixture()
    tracker.start({ setup_flow_id: flow, already_pro: false })
    tracker.view('scan', unknown)
    tracker.visibility(false); tracker.visibility(false)
    tracker.visibility(true); tracker.view('scan', unknown)
    tracker.view('reveal', unknown)
    await tracker.flush()
    assert.equal(sent.filter(event => event.event === 'setup_page_hidden').length, 1)
    assert.equal(sent.filter(event => event.event === 'setup_step_viewed').length, 2)
  })
  it('attributes a late async failure to the visit that started its request', async () => {
    const { tracker, sent } = fixture()
    tracker.start({ setup_flow_id: flow, already_pro: false })
    tracker.view('scan', unknown)
    const failed = tracker.failure('upload_consent_failed')
    tracker.view('reveal', unknown)
    failed()
    await tracker.flush()
    assert.equal(sent.at(-1)?.step, 'scan')
    assert.equal(sent.at(-1)?.visit_id, sent[0].visit_id)
  })
  it('keeps failed deliveries in the completion batch until they are acknowledged', async () => {
    const tracker = createSetupTracker(async () => { throw new Error('offline') })
    tracker.start({ setup_flow_id: flow, already_pro: false })
    tracker.view('scan', unknown)
    tracker.view('workspace', home)
    await tracker.flush()
    const batch = tracker.completionEvents()
    assert.deepEqual(batch.map(event => event.event), ['setup_step_viewed', 'setup_step_transitioned', 'setup_step_viewed', 'setup_step_transitioned', 'setup_completed'])
    assert.equal(batch[2].visit_id, batch[3].visit_id)
    assert.equal(batch[3].visit_id, batch[4].visit_id)
  })
  it('retries a temporary context failure while preserving explicit opt-out', async () => {
    let attempts = 0
    let stop = () => {}
    const recovered = await new Promise<unknown>(resolve => {
      stop = connectSetupTelemetry(resolve, async () => {
        if (++attempts === 1) throw new Error('temporary worker failure')
        return { setup_flow_id: flow, already_pro: false }
      }, 1)
    })
    stop()
    assert.deepEqual(recovered, { setup_flow_id: flow, already_pro: false })
    assert.equal(attempts, 2)
    attempts = 0
    const disabled = await new Promise(resolve => {
      stop = connectSetupTelemetry(resolve, async () => { attempts++; return null }, 1)
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    stop()
    assert.equal(disabled, null)
    assert.equal(attempts, 1)
  })
  it('cancels a pending context retry on unmount', async () => {
    let attempts = 0
    const stop = connectSetupTelemetry(() => { throw new Error('must not publish') }, async () => { attempts++; throw new Error('offline') }, 20)
    await new Promise(resolve => setTimeout(resolve, 2))
    stop()
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(attempts, 1)
  })
  it('does not treat non-2xx responses as consent or delivery acknowledgement', async () => {
    const saved = globalThis.fetch
    const { tracker } = fixture()
    tracker.start({ setup_flow_id: flow, already_pro: false })
    tracker.view('workspace', home)
    const event = tracker.completionEvents().at(-1)!
    try {
      globalThis.fetch = async () => new Response('', { status: 503 })
      await assert.rejects(readSetupTelemetryContext)
      await assert.rejects(() => sendSetupEvent(event))
      globalThis.fetch = async () => Response.json({ context: null })
      assert.equal(await readSetupTelemetryContext(), null)
      globalThis.fetch = async () => Response.json({})
      await assert.rejects(readSetupTelemetryContext)
    } finally { globalThis.fetch = saved }
  })
})

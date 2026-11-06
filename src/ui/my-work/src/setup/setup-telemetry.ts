import { SETUP_STEPS, isSetupId, type SetupAction, type SetupError, type SetupEvent, type SetupStep, type SetupTelemetryContext } from '../../../../shared/setup-funnel.ts'

export interface VisitState { branch: 'home' | 'go'; branch_confirmed: boolean; importComplete?: boolean }
type PendingEvent = Omit<SetupEvent, 'setup_flow_id' | 'already_pro'>
type Visit = { id: string; step: SetupStep; state: VisitState }

/** Records actual rendered visits, not clicks that might fail to navigate. */
export function createSetupTracker(send: (event: SetupEvent) => Promise<void>, options: { uuid?: () => string; now?: () => number } = {}) {
  const uuid = options.uuid ?? (() => crypto.randomUUID())
  const now = options.now ?? Date.now
  let context: SetupTelemetryContext | null = null
  let visit: Visit | null = null
  let completed = false
  let hidden = false
  let queue: PendingEvent[] = []
  const errors = new Set<string>()
  let sending = Promise.resolve()
  const deliver = (event: PendingEvent) => {
    if (!context) { if (queue.length < 200) queue.push(event); return }
    const payload: SetupEvent = { ...event, setup_flow_id: context.setup_flow_id, already_pro: context.already_pro }
    sending = sending.then(() => send(payload)).catch(() => {})
  }
  const event = (name: SetupEvent['event'], extra: Partial<PendingEvent> = {}, origin = visit): PendingEvent | null => origin ? ({
    event: name, event_id: uuid(), setup_funnel_version: 1, visit_id: origin.id, step: origin.step,
    branch: origin.state.branch, branch_confirmed: origin.state.branch_confirmed, occurred_at: now(), ...extra,
  }) : null
  const recordError = (error_code: SetupError, origin = visit) => {
    const key = `${origin?.id}:${error_code}`
    if (errors.has(key)) return
    const item = event('setup_step_error', { error_code }, origin)
    if (item) { errors.add(key); deliver(item) }
  }
  return {
    start(value: SetupTelemetryContext | null) {
      if (!value || !isSetupId(value.setup_flow_id)) { queue = []; return }
      context = value
      const pending = queue; queue = []; pending.forEach(deliver)
    },
    view(step: SetupStep, state: VisitState) {
      if (completed || visit?.step === step) return
      if (visit) {
        const direction = visit.step === 'import' && step === 'finish-setup'
          ? state.importComplete ? 'forward' : 'back'
          : SETUP_STEPS.indexOf(step) > SETUP_STEPS.indexOf(visit.step) ? 'forward' : 'back'
        deliver(event('setup_step_transitioned', { to_step: step, direction })!)
      }
      visit = { id: uuid(), step, state: { ...state } }; hidden = false
      deliver(event('setup_step_viewed')!)
    },
    action(action: SetupAction, state?: VisitState) {
      const item = event('setup_step_action', { action, ...(state ? { branch: state.branch, branch_confirmed: state.branch_confirmed } : {}) })
      if (item && !completed) deliver(item)
    },
    error: recordError,
    /** An async request may fail after navigation; keep the visit that launched it. */
    failure(error_code: SetupError) { const origin = visit; return () => recordError(error_code, origin) },
    visibility(visible: boolean) {
      if (visible) { hidden = false; return }
      if (hidden || completed) return
      hidden = true
      const item = event('setup_page_hidden'); if (item) deliver(item)
    },
    /** Sent with /api/setup/complete; the worker emits these only after its real successful write. */
    completionEvents(): SetupEvent[] {
      if (!context || !visit || visit.step !== 'workspace' || completed) return []
      return [event('setup_step_transitioned', { to_step: 'complete', direction: 'forward' })!, event('setup_completed')!]
        .map(item => ({ ...item, setup_flow_id: context!.setup_flow_id, already_pro: context!.already_pro }))
    },
    complete() { completed = true },
    flush() { return sending },
  }
}

export async function readSetupTelemetryContext(): Promise<SetupTelemetryContext | null> {
  try {
    const response = await fetch('/api/setup/telemetry', { cache: 'no-store' })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const value = body && typeof body === 'object' ? (body as { context?: SetupTelemetryContext }).context : null
    return value && isSetupId(value.setup_flow_id) && typeof value.already_pro === 'boolean' ? value : null
  } catch { return null }
}

export async function sendSetupEvent(event: SetupEvent): Promise<void> {
  await fetch('/api/setup/telemetry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    keepalive: true, signal: AbortSignal.timeout(2_000),
  })
}

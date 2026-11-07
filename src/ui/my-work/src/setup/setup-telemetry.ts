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
  const unacknowledged = new Map<string, SetupEvent>()
  let sending = Promise.resolve()
  const deliver = (event: PendingEvent) => {
    if (!context) { if (queue.length < 200) queue.push(event); return }
    const payload: SetupEvent = { ...event, setup_flow_id: context.setup_flow_id, already_pro: context.already_pro }
    if (unacknowledged.size >= 200) unacknowledged.delete(unacknowledged.keys().next().value!)
    unacknowledged.set(payload.event_id, payload)
    sending = sending.then(async () => { await send(payload); unacknowledged.delete(payload.event_id) }).catch(() => {})
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
      const finished = [event('setup_step_transitioned', { to_step: 'complete', direction: 'forward' })!, event('setup_completed')!]
        .map(item => ({ ...item, setup_flow_id: context!.setup_flow_id, already_pro: context!.already_pro }))
      // A slow/failed local POST must not strand earlier visits when completion
      // lets the installer remove the session. The worker deduplicates event IDs.
      return [...unacknowledged.values(), ...finished]
    },
    complete() { completed = true },
    flush() { return sending },
  }
}

export async function readSetupTelemetryContext(): Promise<SetupTelemetryContext | null> {
  const response = await fetch('/api/setup/telemetry', { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error('Setup telemetry context is temporarily unavailable.')
  const body: unknown = await response.json()
  const value = body && typeof body === 'object' ? (body as { context?: SetupTelemetryContext }).context : undefined
  if (value === null) return null // An explicit opt-out / absent live installer is final.
  if (value && isSetupId(value.setup_flow_id) && typeof value.already_pro === 'boolean') return value
  throw new Error('Setup telemetry context was incomplete.')
}

/** Retry a temporarily unavailable worker without holding up setup or treating failure as opt-out. */
export function connectSetupTelemetry(ready: (context: SetupTelemetryContext | null) => void,
  read = readSetupTelemetryContext, retryMs = 1_000): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const connect = async () => {
    try { const context = await read(); if (!stopped) ready(context) }
    catch { if (!stopped) timer = setTimeout(() => void connect(), retryMs) }
  }
  void connect()
  return () => { stopped = true; clearTimeout(timer) }
}

export async function sendSetupEvent(event: SetupEvent): Promise<void> {
  const response = await fetch('/api/setup/telemetry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    keepalive: true, signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error('Setup telemetry delivery was not acknowledged.')
}

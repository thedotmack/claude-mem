import { parseSetupEvent, type SetupEvent, type SetupTelemetryContext } from '../../shared/setup-funnel.js';
import { readSetupTelemetryContext } from '../../shared/setup-state.js';
import { loadTelemetryConfig, resolveTelemetryConsent } from '../telemetry/consent.js';
import { captureSetupEvent } from '../telemetry/telemetry.js';

/** The local worker is the only telemetry transport; the browser never gets an ingestion key. */
export function createSetupTelemetry(statePath: string, options: {
  consent?: () => boolean;
  capture?: (event: SetupEvent) => void;
  now?: () => number;
} = {}) {
  const consent = options.consent ?? (() => resolveTelemetryConsent(process.env, loadTelemetryConfig()));
  const capture = options.capture ?? captureSetupEvent;
  const now = options.now ?? Date.now;
  let flowId: string | null = null;
  const received = new Set<string>();
  const exitedVisits = new Set<string>();
  const matching = (value: unknown, context: SetupTelemetryContext | null): SetupEvent | null => {
    const event = parseSetupEvent(value);
    return event && context && event.setup_flow_id === context.setup_flow_id && event.already_pro === context.already_pro
      && Math.abs(now() - event.occurred_at) <= 5 * 60_000 ? event : null;
  };
  const accept = (event: SetupEvent): boolean => {
    if (!consent()) return false;
    if (flowId !== event.setup_flow_id) { flowId = event.setup_flow_id; received.clear(); exitedVisits.clear(); }
    if (received.has(event.event_id)) return true;
    if (event.event === 'setup_step_transitioned' && exitedVisits.has(event.visit_id)) return true;
    if (received.size >= 2_000) return false;
    received.add(event.event_id);
    if (event.event === 'setup_step_transitioned') exitedVisits.add(event.visit_id);
    try { capture(event); } catch { /* Analytics must not change a setup response. */ }
    return true;
  };
  return {
    context() { return consent() ? readSetupTelemetryContext(statePath) : null; },
    receive(value: unknown): boolean {
      const context = consent() ? readSetupTelemetryContext(statePath) : null;
      const event = matching(value, context);
      if (!event || event.event === 'setup_completed' || event.to_step === 'complete') return false;
      return accept(event);
    },
    /** Validate while the installer marker exists; invoke only after its completion write succeeds. */
    prepareCompletion(value: unknown): () => void {
      const context = consent() ? readSetupTelemetryContext(statePath) : null;
      if (!Array.isArray(value) || value.length !== 2) return () => {};
      const events = value.map(item => matching(item, context));
      const [transition, complete] = events;
      if (!transition || !complete || transition.event !== 'setup_step_transitioned' || transition.to_step !== 'complete'
        || complete.event !== 'setup_completed' || transition.visit_id !== complete.visit_id) return () => {};
      return () => { accept(transition); accept(complete); };
    },
  };
}

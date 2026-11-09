/** Closed, content-free contract for the local installer's actual screens. */
export const SETUP_STEPS = ['scan', 'reveal', 'choice', 'savings', 'checkout', 'finish-setup', 'import', 'launch', 'workspace'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const SETUP_ACTIONS = ['choose_memory', 'choice_committed', 'open_checkout', 'start_import', 'skip_import', 'retry_scan', 'upload_allowed', 'upload_skipped'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];
export const SETUP_ERRORS = ['scan_failed', 'scan_retry_failed', 'upload_consent_failed', 'usage_preference_failed', 'choice_failed', 'checkout_failed', 'installer_failed', 'import_failed', 'complete_failed'] as const;
export type SetupError = (typeof SETUP_ERRORS)[number];
export type SetupEventName = 'setup_step_viewed' | 'setup_step_transitioned' | 'setup_step_action' | 'setup_step_error' | 'setup_page_hidden' | 'setup_completed';
export interface SetupEvent {
  event: SetupEventName;
  event_id: string;
  setup_flow_id: string;
  setup_funnel_version: 1;
  visit_id: string;
  step: SetupStep;
  branch: 'home' | 'go';
  already_pro: boolean;
  branch_confirmed: boolean;
  occurred_at: number;
  to_step?: SetupStep | 'complete';
  direction?: 'forward' | 'back';
  action?: SetupAction;
  error_code?: SetupError;
}
export interface SetupTelemetryContext { setup_flow_id: string; already_pro: boolean }
export const isSetupId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.includes(value as T);

/** Reject unknown keys rather than allowing prompts, URLs or errors to ride along. */
export function parseSetupEvent(value: unknown): SetupEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const base = ['event', 'event_id', 'setup_flow_id', 'setup_funnel_version', 'visit_id', 'step', 'branch', 'already_pro', 'branch_confirmed', 'occurred_at'];
  const extra = v.event === 'setup_step_transitioned' ? ['to_step', 'direction'] : v.event === 'setup_step_action' ? ['action'] : v.event === 'setup_step_error' ? ['error_code'] : [];
  if (!member(['setup_step_viewed', 'setup_step_transitioned', 'setup_step_action', 'setup_step_error', 'setup_page_hidden', 'setup_completed'], v.event)
    || Object.keys(v).some(key => !base.includes(key) && !extra.includes(key))
    || !isSetupId(v.event_id) || !isSetupId(v.setup_flow_id) || !isSetupId(v.visit_id)
    || v.setup_funnel_version !== 1 || !member(SETUP_STEPS, v.step)
    || !member(['home', 'go'], v.branch) || typeof v.already_pro !== 'boolean' || typeof v.branch_confirmed !== 'boolean'
    || typeof v.occurred_at !== 'number' || !Number.isSafeInteger(v.occurred_at) || v.occurred_at <= 0) return null;
  if (v.event === 'setup_step_transitioned' && ((!member(SETUP_STEPS, v.to_step) && v.to_step !== 'complete') || !member(['forward', 'back'], v.direction) || v.to_step === v.step)) return null;
  if (v.event === 'setup_step_action' && !member(SETUP_ACTIONS, v.action)) return null;
  if (v.event === 'setup_step_error' && !member(SETUP_ERRORS, v.error_code)) return null;
  if ((v.event === 'setup_completed' || v.to_step === 'complete') && (v.step !== 'workspace' || (v.to_step === 'complete' && v.direction !== 'forward'))) return null;
  return v as unknown as SetupEvent;
}

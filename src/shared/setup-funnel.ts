/** Closed, content-free contract for the local installer's actual screens. */
export const SETUP_STEPS = ['scan', 'reveal', 'choice', 'savings', 'checkout', 'finish-setup', 'import', 'launch', 'workspace'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

// The funnel's states as they cross between the installer, the worker and the setup page. Each has its one
// definition here, in the only module all three can load: the worker's files and request checks and the page's
// types use these, so a state added on one side cannot be missing on another.

/** Where memory lives: on this computer (`home`) or on the go through cmem.ai (`go`). */
export const SETUP_BRANCHES = ['home', 'go'] as const;
export type SetupBranch = (typeof SETUP_BRANCHES)[number];

/** Who generates memories: CMEM Pro (hosted) or the person's own token plan. */
export const SETUP_MEMORY_BILLINGS = ['hosted', 'existing'] as const;
export type SetupMemoryBilling = (typeof SETUP_MEMORY_BILLINGS)[number];

/**
 * What the installer has done with the browser's choice. Phase 8 (checkout) picks up from `go-awaiting-checkout`:
 * the installer holds the started pairing in memory and waits for the checkout request.
 */
export const SETUP_INSTALLER_STAGES = ['waiting-for-choice', 'home-ready', 'go-kept-existing-pro', 'go-awaiting-checkout', 'failed'] as const;
export type SetupInstallerStage = (typeof SETUP_INSTALLER_STAGES)[number];

/**
 * On The Go checkout (funnel Phase 8). The page asks (`requested`, counted so a second ask reopens the checkout);
 * the installer runs the existing pairing checkout and reports `waiting`, then `paid` or `failed`.
 */
export type SetupCheckoutState = 'requested' | 'waiting' | 'paid' | 'failed';

/** The funnel shows until `complete`, for new installs and upgrades alike. */
export type SetupStatus = 'pending' | 'complete';

/**
 * The prompt scan (services/prompt-import/setup-scan.ts, the only writer):
 *
 *   idle → reading → checking → saving ─┬→ awaiting-consent ─┬→ uploading → done
 *                                       │                    └→ done        (the person keeps the prompts local)
 *                                       ├→ uploading → done                 (no prompts, so nothing to ask about)
 *                                       └→ done                             (no extractor is set)
 *   reading, checking, saving, awaiting-consent, uploading → failed
 *   done, failed → reading                                                  (the next start)
 *
 * `checking` is entered only when the transcript scan reports it.
 */
export type SetupScanPhase = 'idle' | 'reading' | 'checking' | 'saving' | 'awaiting-consent' | 'uploading' | 'done' | 'failed';

/**
 * The history upload (services/setup/history-import.ts, the only writer): idle → running → done | failed.
 * A start after `done` or `failed` runs it again; one that cannot read the database fails without running.
 */
export type HistoryImportRunState = 'idle' | 'running' | 'done' | 'failed';
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
  branch: SetupBranch;
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
    || !member(SETUP_BRANCHES, v.branch) || typeof v.already_pro !== 'boolean' || typeof v.branch_confirmed !== 'boolean'
    || typeof v.occurred_at !== 'number' || !Number.isSafeInteger(v.occurred_at) || v.occurred_at <= 0) return null;
  if (v.event === 'setup_step_transitioned' && ((!member(SETUP_STEPS, v.to_step) && v.to_step !== 'complete') || !member(['forward', 'back'], v.direction) || v.to_step === v.step)) return null;
  if (v.event === 'setup_step_action' && !member(SETUP_ACTIONS, v.action)) return null;
  if (v.event === 'setup_step_error' && !member(SETUP_ERRORS, v.error_code)) return null;
  if ((v.event === 'setup_completed' || v.to_step === 'complete') && (v.step !== 'workspace' || (v.to_step === 'complete' && v.direction !== 'forward'))) return null;
  return v as unknown as SetupEvent;
}

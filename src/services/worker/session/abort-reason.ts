import { DEADLINE_EXCEEDED_CODE } from '../provider-errors.js';

/**
 * The one authority on abort reasons (#3461). `session.abortReason` is a
 * category, optionally followed by ':' and detail ('quota:<window>',
 * 'transport:transient'). The exit handler decides from the category whether a
 * session survives its generator; telemetry reports the closed enum below.
 * Both read it here, so a new category cannot be preserved in one place and
 * reported as 'none' (or the reverse) in the other.
 */

export type NormalizedAbortReason =
  | 'idle'
  | 'shutdown'
  | 'overflow'
  | 'restart_guard'
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'provider_switch'
  | 'output_retry'
  | 'drift'
  | typeof DEADLINE_EXCEEDED_CODE
  | 'none';

/** The category of a raw abort reason: the text before the first ':'. */
export function abortCategoryOf(reason: string | null | undefined): string {
  return (reason ?? '').split(':')[0];
}

/**
 * Pauses that keep the session and its buffered work for a later generator
 * instead of finalizing it. Every one of them has already reset its claimed
 * batch to pending (provider_switch parks a live buffer; drift has already
 * stored and confirmed its batch).
 */
export const PRESERVED_ABORT_CATEGORIES: ReadonlySet<string> = new Set([
  'quota',
  'rate_limit',
  'auth',
  'overflow',
  'provider_switch',
  'transport',
  'output_retry',
  'drift',
]);

/**
 * Collapse session.abortReason onto a closed telemetry enum. The raw value can
 * carry free text after a colon (e.g. 'quota:<provider message>') — never emit
 * it verbatim. Unknown or absent reasons map to 'none'.
 */
export function normalizeAbortReason(reason: string | null | undefined): NormalizedAbortReason {
  // The one transport pause that is ours: a request abandoned at the LLM
  // deadline, possibly already billed upstream. Every other transport pause
  // stays 'none', as before.
  if (reason === `transport:${DEADLINE_EXCEEDED_CODE}`) return DEADLINE_EXCEEDED_CODE;
  switch (abortCategoryOf(reason)) {
    case 'idle': return 'idle';
    case 'shutdown': return 'shutdown';
    case 'overflow': return 'overflow';
    case 'restart-guard': return 'restart_guard';
    case 'quota': return 'quota';
    case 'rate_limit': return 'rate_limit';
    case 'auth': return 'auth';
    case 'provider_switch': return 'provider_switch';
    case 'output_retry': return 'output_retry';
    case 'drift': return 'drift';
    default: return 'none';
  }
}

export interface ObserverCaptureSettings {
  CLAUDE_MEM_OBSERVER_ENABLED?: unknown;
}

/**
 * The user-controlled hard gate for observation and session-summary capture.
 *
 * Only the explicit string "false" disables capture. Missing values keep
 * existing installs enabled, and malformed values fail open so a typo cannot
 * silently discard memory events.
 */
export function isObserverCaptureEnabled(settings: ObserverCaptureSettings): boolean {
  return settings.CLAUDE_MEM_OBSERVER_ENABLED !== 'false';
}

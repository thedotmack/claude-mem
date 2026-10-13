// Once-per-session gate for Kimi context injection.
//
// Kimi only appends hook stdout to model context for UserPromptSubmit (a
// blockable event); SessionStart stdout is dropped. The kimi harness therefore
// injects the observation timeline from the UserPromptSubmit composite hook
// (session-init-context) — which fires on EVERY prompt. To keep the timeline
// from being re-injected on every message, the composite handler records a
// marker here after a successful injection and skips the context fetch while
// the marker exists. summarizeHandler clears the marker on kimi PreCompact/Stop
// so the first prompt after a compaction re-injects a fresh timeline.
//
// Fail-open throughout: a filesystem error must never break a hook. On error
// hasInjected reports false (prefer a duplicate injection over losing context).
import { sessionMarkerFiles } from './session-marker-files.js';

const injectedMarkers = sessionMarkerFiles('kimi-context-injected', 'kimi-context-gate');

export function hasInjected(sessionId: string): boolean {
  return injectedMarkers.has(sessionId);
}

export function markInjected(sessionId: string): void {
  injectedMarkers.mark(sessionId);
}

export function clearInjected(sessionId: string): void {
  injectedMarkers.clear(sessionId);
}

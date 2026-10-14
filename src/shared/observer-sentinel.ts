/**
 * One authority for the opencode observer's sentinel strings, so the spawner
 * (services/worker), the worker skips (utils + http ingest) and the OpenCode
 * plugin (bundle-safe core) cannot drift apart.
 */
export const OBSERVER_SESSION_TITLE = 'claude-mem-observer';

/** First line of every spawned observer prompt. Never a phrase a person would type. */
export const OBSERVER_PROMPT_SENTINEL =
  '[claude-mem-observer: reply with plain text only, do not call any tools]';

/**
 * Whether text is an observer-spawned prompt. The opencode service stores
 * `run` message text wrapped in a layer of double quotes (verified
 * end-to-end 2026-10-14: stored text is `"[claude-mem-observer: ...]"`), so
 * the match strips surrounding quotes and whitespace first. Callers still
 * scope it by platform (opencode only): the same text from any other host is
 * a person's prompt.
 */
export function isObserverPromptSentinel(text: string): boolean {
  if (!text) return false;
  const opening = text.trim().replace(/^"+/, '').replace(/"+$/, '');
  return opening.startsWith(OBSERVER_PROMPT_SENTINEL);
}

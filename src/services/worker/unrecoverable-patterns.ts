/**
 * Unrecoverable error patterns
 *
 * Error messages matching any of these substrings should NOT trigger a restart
 * of the SDK generator. Retrying them will fail identically and drain API
 * budget / Max-plan usage (see windows-max-plan-drain-fix plan, Phase 3).
 *
 * Matching is a plain substring check via `String.prototype.includes`, so
 * patterns must be specific enough to avoid false positives (e.g. bare `'401'`
 * would match request IDs and is forbidden — use agent-prefixed forms).
 */

export const UNRECOVERABLE_ERROR_PATTERNS: readonly string[] = [
  'Claude executable not found',
  'CLAUDE_CODE_PATH',
  'ENOENT',
  'spawn',
  'Invalid API key',
  'API_KEY_INVALID',
  'API key expired',
  'API key not valid',
  'PERMISSION_DENIED',
  'Gemini API error: 400',
  'Gemini API error: 401',
  'Gemini API error: 403',
  // OAuth / subscription-token expiry (Max plan users) — matches SDK
  // subprocess error messages when the inherited CLAUDE_CODE_OAUTH_TOKEN
  // is no longer valid.
  'OAuth token expired',
  'token has been revoked',
  'Unauthorized',
  // Parallel to 'Gemini API error: 401' — catches OpenRouter OAuth failures.
  'OpenRouter API error: 401',
  'OpenRouter API error: 403',
  'FOREIGN KEY constraint failed',
];

/**
 * Returns true if the given error message matches any unrecoverable pattern.
 * Accepts an empty / non-string input and returns false in that case.
 */
export function isUnrecoverableError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  return UNRECOVERABLE_ERROR_PATTERNS.some(pattern => errorMessage.includes(pattern));
}

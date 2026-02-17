/**
 * API endpoint paths
 * Centralized to avoid magic strings scattered throughout the codebase
 */
export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  STATS: '/api/stats',
  PROCESSING_STATUS: '/api/processing-status',
  STREAM: '/stream',
} as const;

/**
 * Read the auth token injected by the server into the HTML page.
 * Returns empty string if not available (should not happen in production).
 */
function getAuthToken(): string {
  return (window as any).__CLAUDE_MEM_TOKEN || '';
}

/**
 * Authenticated fetch wrapper that includes the Bearer token header.
 * Drop-in replacement for window.fetch — same signature, adds Authorization header.
 */
export function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', 'Bearer ' + token);
  }
  return fetch(input, { ...init, headers });
}

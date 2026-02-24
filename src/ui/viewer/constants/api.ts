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
  SEARCH: '/api/search',
  STREAM: '/stream',
  ANALYTICS: '/api/analytics',
  ACTIVE_SESSIONS: '/api/sessions/active',
  SESSIONS_BASE: '/api/sessions',
  CLOSE_STALE_SESSIONS: '/api/sessions/close-stale',
} as const;

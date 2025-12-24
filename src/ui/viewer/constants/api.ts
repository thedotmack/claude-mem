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
  SEARCH: '/api/search',
  GRAPH_CONCEPTS: '/api/graph/concepts',
  GRAPH_OBSERVATIONS: '/api/graph/observations',
  GRAPH_PROJECTS: '/api/graph/projects',
  GRAPH_USAGE_STATS: '/api/graph/usage-stats',
  // Cross-project insights and session clustering
  GRAPH_INSIGHTS: '/api/graph/insights',
  GRAPH_SESSIONS: '/api/graph/sessions',
  // Health/Logging endpoints
  HEALTH_SUMMARY: '/api/health/summary',
  LOGS: '/api/logs',
  ERROR_PATTERNS: '/api/errors/patterns',
} as const;

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
} as const;

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
  // Maintenance endpoints
  MAINTENANCE_CLEANUP_PREVIEW: '/api/maintenance/cleanup/preview',
  MAINTENANCE_CLEANUP: '/api/maintenance/cleanup',
  MAINTENANCE_STATS: '/api/maintenance/stats',
} as const;

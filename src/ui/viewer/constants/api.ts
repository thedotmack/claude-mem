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
  // Collaboration endpoints
  STATUS: '/api/status',
  MAILBOX: '/api/mailbox',
  CONTROLS: '/api/controls',
  PLANS: '/api/plans',
  LOCKS: '/api/locks',
  PROMPT: '/api/prompt',
  BROWSE: '/api/projects/browse',
  DELEGATE: '/api/delegate',
  TASKS: '/api/tasks',
  CHAT: '/api/chat',
  CHAT_HISTORY: '/api/chat/history',
} as const;

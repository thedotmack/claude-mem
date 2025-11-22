/**
 * Default settings values for Claude Memory
 * Shared across UI components and hooks
 */
export const DEFAULT_SETTINGS = {
  CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
  CLAUDE_MEM_WORKER_PORT: '37777',
} as const;

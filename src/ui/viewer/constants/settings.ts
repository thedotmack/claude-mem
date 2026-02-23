/**
 * Default settings values for Claude Memory
 * Shared across UI components and hooks
 */
export const DEFAULT_SETTINGS = {
  MAGIC_CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
  MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
  MAGIC_CLAUDE_MEM_WORKER_PORT: '37777',
  MAGIC_CLAUDE_MEM_WORKER_HOST: '127.0.0.1',

  // AI Provider Configuration
  MAGIC_CLAUDE_MEM_PROVIDER: 'claude',
  MAGIC_CLAUDE_MEM_GEMINI_API_KEY: '',
  MAGIC_CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY: '',
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'xiaomi/mimo-v2-flash:free',
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL: '',
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME: 'magic-claude-mem',
  MAGIC_CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',

  // Token Economics (all true for backwards compatibility)
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',

  // Observation Filtering (all types and concepts)
  MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: 'bugfix,feature,refactor,discovery,decision,change',
  MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: 'how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off',

  // Display Configuration
  MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT: '5',
  MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
  MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',

  // Feature Toggles
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
} as const;

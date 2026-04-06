/**
 * Default settings values for Claude Memory
 * Shared across UI components and hooks
 */
export const DEFAULT_SETTINGS = {
  CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
  CLAUDE_MEM_WORKER_PORT: '37777',
  CLAUDE_MEM_WORKER_HOST: '127.0.0.1',

  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: 'claude',
  CLAUDE_MEM_GEMINI_API_KEY: '',
  CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
  CLAUDE_MEM_OPENROUTER_API_KEY: '',
  CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
  CLAUDE_MEM_OPENROUTER_SITE_URL: '',
  CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem',
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',

  // Ollama (local) Provider Settings
  CLAUDE_MEM_OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  CLAUDE_MEM_OLLAMA_MODEL: 'qwen2.5-coder:7b',
  CLAUDE_MEM_OLLAMA_TEMPERATURE: '0.2',
  CLAUDE_MEM_OLLAMA_MAX_CONTEXT_MESSAGES: '20',
  CLAUDE_MEM_OLLAMA_MAX_TOKENS: '100000',
  CLAUDE_MEM_OLLAMA_FALLBACK_TO_CLAUDE: 'false',

  // Token Economics — match SettingsDefaultsManager defaults (off by default to keep context lean)
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',

  // Display Configuration — match SettingsDefaultsManager defaults
  CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
  CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',

  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',

  // Exclusion Settings
  CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]',
} as const;

/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
// NOTE: Do NOT import logger here - it creates a circular dependency
// logger.ts depends on SettingsDefaultsManager for its initialization

export interface SettingsDefaults {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;
  CLAUDE_MEM_SKIP_TOOLS: string;
  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: string;  // 'claude' | 'gemini' | 'openrouter'
  CLAUDE_MEM_CLAUDE_AUTH_METHOD: string;  // 'cli' | 'api' - how Claude provider authenticates
  CLAUDE_MEM_GEMINI_API_KEY: string;
  CLAUDE_MEM_GEMINI_MODEL: string;  // 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash-preview'
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: string;  // 'true' | 'false' - enable rate limiting for free tier
  CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES: string;  // Max messages in Gemini context window (prevents O(N²) cost growth)
  CLAUDE_MEM_GEMINI_MAX_TOKENS: string;  // Max estimated tokens for Gemini context (~100k safety limit)
  CLAUDE_MEM_OPENROUTER_API_KEY: string;
  CLAUDE_MEM_OPENROUTER_MODEL: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME: string;
  CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
  CLAUDE_MEM_OPENROUTER_MAX_TOKENS: string;
  // System Configuration
  CLAUDE_MEM_DATA_DIR: string;
  CLAUDE_MEM_LOG_LEVEL: string;
  CLAUDE_MEM_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  CLAUDE_MEM_MODE: string;
  // Token Economics
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: string;
  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  CLAUDE_MEM_FOLDER_USE_LOCAL_MD: string;  // 'true' | 'false' - write to CLAUDE.local.md instead of CLAUDE.md
  CLAUDE_MEM_TRANSCRIPTS_ENABLED: string;  // 'true' | 'false' - enable transcript watcher ingestion for Codex and other transcript-based clients
  CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: string;  // Path to transcript watcher config JSON
  // Process Management
  CLAUDE_MEM_MAX_CONCURRENT_AGENTS: string;  // Max concurrent Claude SDK agent subprocesses (default: 2)
  // Exclusion Settings
  CLAUDE_MEM_EXCLUDED_PROJECTS: string;  // Comma-separated glob patterns for excluded project paths
  CLAUDE_MEM_FOLDER_MD_EXCLUDE: string;  // JSON array of folder paths to exclude from CLAUDE.md generation
  // Semantic Context Injection (per-prompt via Chroma)
  CLAUDE_MEM_SEMANTIC_INJECT: string;        // 'true' | 'false' - inject relevant observations on each prompt
  CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: string;  // Max observations to inject per prompt
  // Tier Routing (model selection by queue complexity)
  CLAUDE_MEM_TIER_ROUTING_ENABLED: string;   // 'true' | 'false' - enable model tier routing
  CLAUDE_MEM_TIER_SIMPLE_MODEL: string;      // Tier alias or model ID for simple tool observations (Read, Glob, Grep)
  CLAUDE_MEM_TIER_SUMMARY_MODEL: string;     // Tier alias or model ID for session summaries
  // Chroma Vector Database Configuration
  CLAUDE_MEM_CHROMA_ENABLED: string;   // 'true' | 'false' - set to 'false' for SQLite-only mode
  CLAUDE_MEM_CHROMA_MODE: string;      // 'local' | 'remote'
  CLAUDE_MEM_CHROMA_HOST: string;
  CLAUDE_MEM_CHROMA_PORT: string;
  CLAUDE_MEM_CHROMA_SSL: string;
  // Future cloud support
  CLAUDE_MEM_CHROMA_API_KEY: string;
  CLAUDE_MEM_CHROMA_TENANT: string;
  CLAUDE_MEM_CHROMA_DATABASE: string;
}

export class SettingsDefaultsManager {
  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    CLAUDE_MEM_MODEL: 'claude-sonnet-4-6',
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_MEM_WORKER_PORT: '37777',
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    // AI Provider Configuration
    CLAUDE_MEM_PROVIDER: 'claude',  // Default to Claude
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'cli',  // Default to CLI subscription billing (not API key)
    CLAUDE_MEM_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',  // Default Gemini model (highest free tier RPM)
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES: '20',  // Max messages in Gemini context window
    CLAUDE_MEM_GEMINI_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    CLAUDE_MEM_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    CLAUDE_MEM_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem',  // App name for OpenRouter analytics
    CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',  // Max messages in context window
    CLAUDE_MEM_OPENROUTER_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    // System Configuration
    CLAUDE_MEM_DATA_DIR: join(homedir(), '.claude-mem'),
    CLAUDE_MEM_LOG_LEVEL: 'INFO',
    CLAUDE_MEM_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    CLAUDE_MEM_MODE: 'code', // Default mode profile
    // Token Economics
    CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    // Display Configuration
    CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
    CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',
    // Feature Toggles
    CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    CLAUDE_MEM_FOLDER_USE_LOCAL_MD: 'false',  // When true, writes to CLAUDE.local.md instead of CLAUDE.md
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'true',
    CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join(homedir(), '.claude-mem', 'transcript-watch.json'),
    // Process Management
    CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent Claude SDK agent subprocesses
    // Exclusion Settings
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CLAUDE.md generation
    // Semantic Context Injection (per-prompt via Chroma vector search)
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',             // Inject relevant past observations on every UserPromptSubmit (experimental, disabled by default)
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    // Tier Routing (model selection by queue complexity)
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',         // Route observations to models by complexity
    CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku', // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    CLAUDE_MEM_TIER_SUMMARY_MODEL: '',                // Empty = use default model for summaries
    // Chroma Vector Database Configuration
    CLAUDE_MEM_CHROMA_ENABLED: 'true',         // Set to 'false' to disable Chroma and use SQLite-only search
    CLAUDE_MEM_CHROMA_MODE: 'local',           // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    CLAUDE_MEM_CHROMA_HOST: '127.0.0.1',
    CLAUDE_MEM_CHROMA_PORT: '8000',
    CLAUDE_MEM_CHROMA_SSL: 'false',
    // Future cloud support (claude-mem pro)
    CLAUDE_MEM_CHROMA_API_KEY: '',
    CLAUDE_MEM_CHROMA_TENANT: 'default_tenant',
    CLAUDE_MEM_CHROMA_DATABASE: 'default_database',
  };

  /**
   * Cloud provider model ID mappings.
   * When CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX are set,
   * the default Anthropic model identifier must be translated to the
   * provider-specific format.
   */
  private static readonly BEDROCK_MODEL_MAP: Record<string, string> = {
    'claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6-v1:0',
    'claude-sonnet-4-5': 'anthropic.claude-sonnet-4-5-v1:0',
    'claude-haiku-3-5': 'anthropic.claude-haiku-3-5-v1:0',
  };

  private static readonly VERTEX_MODEL_MAP: Record<string, string> = {
    'claude-sonnet-4-6': 'claude-sonnet-4-6@20250514',
    'claude-sonnet-4-5': 'claude-sonnet-4-5@20250514',
    'claude-haiku-3-5': 'claude-haiku-3-5@20250514',
  };

  /**
   * Detect active cloud provider from environment variables.
   * Returns 'bedrock', 'vertex', or null for direct Anthropic API.
   */
  static detectCloudProvider(): 'bedrock' | 'vertex' | null {
    if (process.env.CLAUDE_CODE_USE_BEDROCK === '1' || process.env.CLAUDE_CODE_USE_BEDROCK === 'true') {
      return 'bedrock';
    }
    if (process.env.CLAUDE_CODE_USE_VERTEX === '1' || process.env.CLAUDE_CODE_USE_VERTEX === 'true') {
      return 'vertex';
    }
    return null;
  }

  /**
   * Map a model identifier to its cloud-provider-specific equivalent.
   * If the user has explicitly set CLAUDE_MEM_MODEL via env or settings, that value
   * is used as-is (the user knows their provider format).
   * Otherwise, when a cloud provider is detected, the default model ID is translated.
   * If no mapping exists, a warning is logged suggesting the user set CLAUDE_MEM_MODEL.
   */
  static resolveModelForCloudProvider(modelId: string): string {
    const provider = this.detectCloudProvider();
    if (!provider) return modelId;

    // If the user explicitly set CLAUDE_MEM_MODEL, trust their value
    if (process.env.CLAUDE_MEM_MODEL) return modelId;

    const map = provider === 'bedrock' ? this.BEDROCK_MODEL_MAP : this.VERTEX_MODEL_MAP;
    const mapped = map[modelId];

    if (mapped) {
      console.log(`[SETTINGS] Cloud provider "${provider}" detected — mapping model "${modelId}" → "${mapped}"`);
      return mapped;
    }

    // Model not in our mapping table — warn and pass through
    console.warn(
      `[SETTINGS] Cloud provider "${provider}" detected but no mapping for model "${modelId}". ` +
      `Set CLAUDE_MEM_MODEL to your provider-specific model ID (e.g. ${provider === 'bedrock' ? '"anthropic.claude-sonnet-4-6-v1:0"' : '"claude-sonnet-4-6@20250514"'}).`
    );
    return modelId;
  }

  /**
   * Check cloud provider auth readiness at startup.
   * When Vertex AI is detected, OAuth/ANTHROPIC_API_KEY validation should be skipped
   * because Vertex uses Google Cloud credentials instead.
   * Logs a warning if the expected credentials for the detected provider are missing.
   */
  static validateCloudProviderAuth(settings: SettingsDefaults): void {
    const provider = this.detectCloudProvider();
    if (!provider) return;

    if (provider === 'vertex') {
      // Vertex AI uses Google Cloud ADC — OAuth token and ANTHROPIC_API_KEY are not required
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT) {
        console.warn(
          '[SETTINGS] Vertex AI detected (CLAUDE_CODE_USE_VERTEX) but neither GOOGLE_APPLICATION_CREDENTIALS ' +
          'nor GOOGLE_CLOUD_PROJECT is set. Vertex auth may fail. Run "gcloud auth application-default login" ' +
          'or set GOOGLE_APPLICATION_CREDENTIALS to your service account key.'
        );
      }
      // Override auth method: CLI OAuth is irrelevant for Vertex
      if (settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD === 'cli') {
        settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD = 'api';
        console.log('[SETTINGS] Vertex AI detected — auth method overridden from "cli" to "api" (Google ADC used instead of Anthropic OAuth)');
      }
    }

    if (provider === 'bedrock') {
      // Bedrock uses AWS IAM — OAuth token and ANTHROPIC_API_KEY are not required
      if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE && !process.env.AWS_DEFAULT_REGION && !process.env.AWS_REGION) {
        console.warn(
          '[SETTINGS] Bedrock detected (CLAUDE_CODE_USE_BEDROCK) but no AWS credentials found. ' +
          'Set AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, and AWS_REGION.'
        );
      }
      // Override auth method: CLI OAuth is irrelevant for Bedrock
      if (settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD === 'cli') {
        settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD = 'api';
        console.log('[SETTINGS] Bedrock detected — auth method overridden from "cli" to "api" (AWS IAM used instead of Anthropic OAuth)');
      }
    }
  }

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a setting value with environment variable override.
   * Priority: process.env > hardcoded default
   *
   * For full priority (env > settings file > default), use loadFromFile().
   * This method is safe to call at module-load time (no file I/O) and still
   * respects environment variable overrides that were previously ignored.
   */
  static get(key: keyof SettingsDefaults): string {
    const value = process.env[key] ?? this.DEFAULTS[key];
    // Resolve cloud-provider-specific model ID when reading the model setting
    if (key === 'CLAUDE_MEM_MODEL') {
      return this.resolveModelForCloudProvider(value);
    }
    return value;
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   * Handles both string 'true' and boolean true from JSON
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.get(key);
    return value === 'true' || value === true;
  }

  /**
   * Apply environment variable overrides to settings
   * Environment variables take highest priority over file and defaults
   */
  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with proper priority: process.env > settings file > defaults
   * Handles all errors (missing file, corrupted JSON, permissions) gracefully
   *
   * Configuration Priority:
   *   1. Environment variables (highest priority)
   *   2. Settings file (~/.claude-mem/settings.json)
   *   3. Default values (lowest priority)
   */
  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          // Use console instead of logger to avoid circular dependency
          console.log('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error);
        }
        // Still apply env var overrides even when file doesn't exist
        return this.applyEnvOverrides(defaults);
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      // MIGRATION: Handle old nested schema { env: {...} }
      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        // Migrate from nested to flat schema
        flatSettings = settings.env;

        // Auto-migrate the file to flat schema
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          console.log('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error);
          // Continue with in-memory migration even if write fails
        }
      }

      // Merge file settings with defaults (flat schema)
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      // Apply environment variable overrides (highest priority)
      const final = this.applyEnvOverrides(result);
      // Resolve cloud-provider-specific model ID
      final.CLAUDE_MEM_MODEL = this.resolveModelForCloudProvider(final.CLAUDE_MEM_MODEL);
      // Validate cloud provider auth and adjust auth method if needed
      this.validateCloudProviderAuth(final);
      return final;
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error);
      // Still apply env var overrides even on error
      const final = this.applyEnvOverrides(this.getAllDefaults());
      final.CLAUDE_MEM_MODEL = this.resolveModelForCloudProvider(final.CLAUDE_MEM_MODEL);
      this.validateCloudProviderAuth(final);
      return final;
    }
  }
}

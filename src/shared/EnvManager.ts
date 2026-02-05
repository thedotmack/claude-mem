/**
 * EnvManager - Centralized environment variable management for claude-mem
 *
 * Provides isolated credential storage in ~/.claude-mem/.env
 * This ensures claude-mem uses its own configured credentials,
 * not random ANTHROPIC_API_KEY values from project .env files.
 *
 * Issue #733: SDK was auto-discovering API keys from user's shell environment,
 * causing memory operations to bill personal API accounts instead of CLI subscription.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

// Path to claude-mem's centralized .env file
const DATA_DIR = join(homedir(), '.claude-mem');
export const ENV_FILE_PATH = join(DATA_DIR, '.env');

// Essential system environment variables that subprocesses need to function
const ESSENTIAL_SYSTEM_VARS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Node.js specific
  'NODE_ENV',
  'NODE_PATH',
  // Platform specific
  'SYSTEMROOT',      // Windows
  'WINDIR',          // Windows
  'PROGRAMFILES',    // Windows
  'APPDATA',         // Windows
  'LOCALAPPDATA',    // Windows
  'XDG_RUNTIME_DIR', // Linux
  'XDG_CONFIG_HOME', // Linux
  'XDG_DATA_HOME',   // Linux
  // Claude Code specific (not credentials)
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DEBUG_LOGS_DIR',
];

// Credential keys that claude-mem manages
export const MANAGED_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
];

export interface ClaudeMemEnv {
  // Credentials (optional - empty means use CLI billing for Claude)
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

/**
 * Parse a .env file content into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse KEY=value format
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Serialize key-value pairs to .env file format
 */
function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    '# claude-mem credentials',
    '# This file stores API keys for claude-mem memory agent',
    '# Edit this file or use claude-mem settings to configure',
    '',
  ];

  for (const [key, value] of Object.entries(env)) {
    if (value) {
      // Quote values that contain spaces or special characters
      const needsQuotes = /[\s#=]/.test(value);
      lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Load credentials from ~/.claude-mem/.env
 * Returns empty object if file doesn't exist (means use CLI billing)
 */
export function loadClaudeMemEnv(): ClaudeMemEnv {
  if (!existsSync(ENV_FILE_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(ENV_FILE_PATH, 'utf-8');
    const parsed = parseEnvFile(content);

    // Only return managed credential keys
    const result: ClaudeMemEnv = {};
    if (parsed.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    if (parsed.GEMINI_API_KEY) result.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    if (parsed.OPENROUTER_API_KEY) result.OPENROUTER_API_KEY = parsed.OPENROUTER_API_KEY;

    return result;
  } catch (error) {
    logger.warn('ENV', 'Failed to load .env file', { path: ENV_FILE_PATH }, error as Error);
    return {};
  }
}

/**
 * Save credentials to ~/.claude-mem/.env
 */
export function saveClaudeMemEnv(env: ClaudeMemEnv): void {
  try {
    // Ensure directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    // Load existing to preserve any extra keys
    const existing = existsSync(ENV_FILE_PATH)
      ? parseEnvFile(readFileSync(ENV_FILE_PATH, 'utf-8'))
      : {};

    // Update with new values
    const updated: Record<string, string> = { ...existing };

    // Only update managed keys
    if (env.ANTHROPIC_API_KEY !== undefined) {
      if (env.ANTHROPIC_API_KEY) {
        updated.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
      } else {
        delete updated.ANTHROPIC_API_KEY;
      }
    }
    if (env.GEMINI_API_KEY !== undefined) {
      if (env.GEMINI_API_KEY) {
        updated.GEMINI_API_KEY = env.GEMINI_API_KEY;
      } else {
        delete updated.GEMINI_API_KEY;
      }
    }
    if (env.OPENROUTER_API_KEY !== undefined) {
      if (env.OPENROUTER_API_KEY) {
        updated.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
      } else {
        delete updated.OPENROUTER_API_KEY;
      }
    }

    writeFileSync(ENV_FILE_PATH, serializeEnvFile(updated), 'utf-8');
  } catch (error) {
    logger.error('ENV', 'Failed to save .env file', { path: ENV_FILE_PATH }, error as Error);
    throw error;
  }
}

/**
 * Build a clean, isolated environment for spawning SDK subprocesses
 *
 * This is the key function that prevents Issue #733:
 * - Includes only essential system variables (PATH, HOME, etc.)
 * - Adds credentials ONLY from claude-mem's .env file
 * - Does NOT inherit random ANTHROPIC_API_KEY from user's shell
 *
 * @param includeCredentials - Whether to include API keys (default: true)
 */
export function buildIsolatedEnv(includeCredentials: boolean = true): Record<string, string> {
  const isolatedEnv: Record<string, string> = {};

  // 1. Copy essential system variables from current process
  for (const key of ESSENTIAL_SYSTEM_VARS) {
    const value = process.env[key];
    if (value !== undefined) {
      isolatedEnv[key] = value;
    }
  }

  // 2. Add SDK entrypoint marker
  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';

  // 3. Add credentials from claude-mem's .env file (NOT from process.env)
  if (includeCredentials) {
    const credentials = loadClaudeMemEnv();

    // Only add ANTHROPIC_API_KEY if explicitly configured in claude-mem
    // If not configured, CLI billing will be used (via pathToClaudeCodeExecutable)
    if (credentials.ANTHROPIC_API_KEY) {
      isolatedEnv.ANTHROPIC_API_KEY = credentials.ANTHROPIC_API_KEY;
    }
    // Note: GEMINI_API_KEY and OPENROUTER_API_KEY are handled by their respective agents
    if (credentials.GEMINI_API_KEY) {
      isolatedEnv.GEMINI_API_KEY = credentials.GEMINI_API_KEY;
    }
    if (credentials.OPENROUTER_API_KEY) {
      isolatedEnv.OPENROUTER_API_KEY = credentials.OPENROUTER_API_KEY;
    }
  }

  return isolatedEnv;
}

/**
 * Get a specific credential from claude-mem's .env
 * Returns undefined if not set (which means use default/CLI billing)
 */
export function getCredential(key: keyof ClaudeMemEnv): string | undefined {
  const env = loadClaudeMemEnv();
  return env[key];
}

/**
 * Set a specific credential in claude-mem's .env
 * Pass empty string to remove the credential
 */
export function setCredential(key: keyof ClaudeMemEnv, value: string): void {
  const env = loadClaudeMemEnv();
  env[key] = value || undefined;
  saveClaudeMemEnv(env);
}

/**
 * Check if claude-mem has an Anthropic API key configured
 * If false, it means CLI billing should be used
 */
export function hasAnthropicApiKey(): boolean {
  const env = loadClaudeMemEnv();
  return !!env.ANTHROPIC_API_KEY;
}

/**
 * Get auth method description for logging
 */
export function getAuthMethodDescription(): string {
  if (hasAnthropicApiKey()) {
    return 'API key (from ~/.claude-mem/.env)';
  }
  return 'Claude Code CLI (subscription billing)';
}

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

// Environment variables to STRIP from subprocess environment (blocklist approach)
// Only ANTHROPIC_API_KEY is stripped because it's the specific variable that causes
// Issue #733: project .env files set ANTHROPIC_API_KEY which the SDK auto-discovers,
// causing memory operations to bill personal API accounts instead of CLI subscription.
//
// All other env vars (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, system vars, etc.)
// are passed through to avoid breaking CLI authentication, proxies, and platform features.
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',  // Issue #733: Prevent auto-discovery from project .env files
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
 * Build a clean environment for spawning SDK subprocesses
 *
 * Uses a BLOCKLIST approach: inherits the full process environment but strips
 * only ANTHROPIC_API_KEY to prevent Issue #733 (accidental billing from project .env files).
 *
 * All other variables pass through, including:
 * - ANTHROPIC_AUTH_TOKEN (CLI subscription auth)
 * - ANTHROPIC_BASE_URL (custom proxy endpoints)
 * - Platform-specific vars (USERPROFILE, XDG_*, etc.)
 *
 * If claude-mem has an explicit ANTHROPIC_API_KEY in ~/.claude-mem/.env, it's re-injected
 * after stripping, so the managed credential takes precedence over any ambient value.
 *
 * @param includeCredentials - Whether to include API keys from ~/.claude-mem/.env (default: true)
 */
export function buildIsolatedEnv(includeCredentials: boolean = true): Record<string, string> {
  // 1. Start with full process environment
  const isolatedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
      isolatedEnv[key] = value;
    }
  }

  // 2. Override SDK entrypoint marker
  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';

  // 3. Re-inject managed credentials from claude-mem's .env file
  if (includeCredentials) {
    const credentials = loadClaudeMemEnv();

    // Only add ANTHROPIC_API_KEY if explicitly configured in claude-mem
    // If not configured, CLI billing will be used (via ANTHROPIC_AUTH_TOKEN passthrough)
    if (credentials.ANTHROPIC_API_KEY) {
      isolatedEnv.ANTHROPIC_API_KEY = credentials.ANTHROPIC_API_KEY;
    }
    // Note: GEMINI_API_KEY and OPENROUTER_API_KEY pass through from process.env,
    // but claude-mem's .env takes precedence if configured
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

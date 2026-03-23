/**
 * Input validation — security boundary.
 * Rejects path traversal, control chars, and oversized inputs.
 */

import { validationError } from '../errors.js';

export function validateSearchQuery(query: string): void {
  if (!query || query.trim().length === 0) {
    throw validationError('Search query is required');
  }
  if (query.length > 500) {
    throw validationError('Query too long (max 500 chars)');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(query)) {
    throw validationError('Query contains invalid control characters');
  }
}

export function validateProjectName(name: string): void {
  if (name.includes('..') || name.includes('\0') || /[<>"|?*]/.test(name)) {
    throw validationError('Invalid project name');
  }
  if (name.length > 200) {
    throw validationError('Project name too long (max 200 chars)');
  }
}

export function validateIds(ids: string[]): number[] {
  if (ids.length === 0) {
    throw validationError('At least one observation ID is required');
  }
  return ids.map(id => {
    const n = parseInt(id, 10);
    if (!Number.isInteger(n) || n < 1) {
      throw validationError(`Invalid observation ID: ${id}`);
    }
    return n;
  });
}

export function validateLimit(limit: string | undefined, max = 100): number {
  if (!limit) return 20;
  const n = parseInt(limit, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw validationError('Limit must be a positive integer');
  }
  return Math.min(n, max);
}

export function validateOffset(offset: string | undefined): number {
  if (!offset) return 0;
  const n = parseInt(offset, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw validationError('Offset must be a non-negative integer');
  }
  return n;
}

/**
 * Allowlisted setting keys.
 * Includes both CMEM_* (preferred) and CLAUDE_MEM_* (backwards compat) aliases.
 */
const ALLOWED_SETTING_KEYS = new Set([
  // CMEM_* keys (preferred)
  'CMEM_MODEL',
  'CMEM_CONTEXT_OBSERVATIONS',
  'CMEM_WORKER_PORT',
  'CMEM_WORKER_HOST',
  'CMEM_PROVIDER',
  'CMEM_GEMINI_API_KEY',
  'CMEM_GEMINI_MODEL',
  'CMEM_GEMINI_RATE_LIMITING_ENABLED',
  'CMEM_OPENROUTER_API_KEY',
  'CMEM_OPENROUTER_MODEL',
  'CMEM_OPENROUTER_SITE_URL',
  'CMEM_OPENROUTER_APP_NAME',
  'CMEM_OPENROUTER_MAX_CONTEXT_MESSAGES',
  'CMEM_OPENROUTER_MAX_TOKENS',
  'CMEM_DATA_DIR',
  'CMEM_LOG_LEVEL',
  'CMEM_PYTHON_VERSION',
  'CMEM_CONTEXT_SHOW_READ_TOKENS',
  'CMEM_CONTEXT_SHOW_WORK_TOKENS',
  'CMEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
  'CMEM_CONTEXT_SHOW_SAVINGS_PERCENT',
  'CMEM_CONTEXT_OBSERVATION_TYPES',
  'CMEM_CONTEXT_OBSERVATION_CONCEPTS',
  'CMEM_CONTEXT_FULL_COUNT',
  'CMEM_CONTEXT_FULL_FIELD',
  'CMEM_CONTEXT_SESSION_COUNT',
  'CMEM_CONTEXT_SHOW_LAST_SUMMARY',
  'CMEM_CONTEXT_SHOW_LAST_MESSAGE',
  'CMEM_FOLDER_CLAUDEMD_ENABLED',
  // CLAUDE_MEM_* keys (backwards compat)
  'CLAUDE_MEM_MODEL',
  'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
  'CLAUDE_MEM_WORKER_PORT',
  'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_GEMINI_MODEL',
  'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_OPENROUTER_SITE_URL',
  'CLAUDE_MEM_OPENROUTER_APP_NAME',
  'CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES',
  'CLAUDE_MEM_OPENROUTER_MAX_TOKENS',
  'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_LOG_LEVEL',
  'CLAUDE_MEM_PYTHON_VERSION',
  'CLAUDE_CODE_PATH',
  'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
  'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
  'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
  'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
  'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
  'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
  'CLAUDE_MEM_CONTEXT_FULL_COUNT',
  'CLAUDE_MEM_CONTEXT_FULL_FIELD',
  'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
  'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
  'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
  'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED',
]);

export function validateSettingKey(key: string): void {
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    throw validationError(
      `Unknown setting: ${key}\nValid keys: ${[...ALLOWED_SETTING_KEYS].sort().join(', ')}`,
    );
  }
}

export function getAllowedSettingKeys(): string[] {
  return [...ALLOWED_SETTING_KEYS].sort();
}

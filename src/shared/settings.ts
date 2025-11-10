/**
 * Shared settings utility
 * Reads configuration from ~/.claude/settings.json or environment variables
 */

import { homedir } from 'os';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

interface ClaudeSettings {
  env?: {
    CLAUDE_MEM_CONTEXT_OBSERVATIONS?: string;
    CLAUDE_MEM_JIT_CONTEXT_ENABLED?: string;
    [key: string]: string | undefined;
  };
  [key: string]: any;
}

/**
 * Read settings from ~/.claude/settings.json
 */
function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = path.join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Fall through to defaults
  }
  return null;
}

/**
 * Get context depth from settings
 * Priority: ~/.claude/settings.json > env var > default (50)
 */
export function getContextDepth(): number {
  const settings = readClaudeSettings();

  if (settings?.env?.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
    const count = parseInt(settings.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
    if (!isNaN(count) && count > 0) {
      return count;
    }
  }

  return parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10);
}

/**
 * Check if JIT context filtering is enabled
 * Priority: ~/.claude/settings.json > env var > default (false)
 */
export function isJitContextEnabled(): boolean {
  const settings = readClaudeSettings();

  if (settings?.env?.CLAUDE_MEM_JIT_CONTEXT_ENABLED !== undefined) {
    const value = settings.env.CLAUDE_MEM_JIT_CONTEXT_ENABLED.toLowerCase();
    return value === 'true' || value === '1';
  }

  const envValue = process.env.CLAUDE_MEM_JIT_CONTEXT_ENABLED?.toLowerCase();
  return envValue === 'true' || envValue === '1';
}

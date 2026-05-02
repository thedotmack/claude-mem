
import { existsSync, readFileSync } from 'fs';
import {join} from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

const DATA_DIR = join(homedir(), '.claude-mem');
export const ENV_FILE_PATH = join(DATA_DIR, '.env');

const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',  // Issue #733: Prevent auto-discovery from project .env files
  'CLAUDECODE',         // Prevent "cannot be launched inside another Claude Code session" error
];

export interface ClaudeMemEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

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

export function loadClaudeMemEnv(): ClaudeMemEnv {
  if (!existsSync(ENV_FILE_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(ENV_FILE_PATH, 'utf-8');
    const parsed = parseEnvFile(content);

    const result: ClaudeMemEnv = {};
    if (parsed.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    if (parsed.ANTHROPIC_BASE_URL) result.ANTHROPIC_BASE_URL = parsed.ANTHROPIC_BASE_URL;
    if (parsed.GEMINI_API_KEY) result.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    if (parsed.OPENROUTER_API_KEY) result.OPENROUTER_API_KEY = parsed.OPENROUTER_API_KEY;

    return result;
  } catch (error: unknown) {
    logger.warn('ENV', 'Failed to load .env file', { path: ENV_FILE_PATH }, error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

export function buildIsolatedEnv(includeCredentials: boolean = true): Record<string, string> {
  const isolatedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
      isolatedEnv[key] = value;
    }
  }

  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';

  isolatedEnv.CLAUDE_MEM_INTERNAL = '1';

  if (includeCredentials) {
    const credentials = loadClaudeMemEnv();

    if (credentials.ANTHROPIC_API_KEY) {
      isolatedEnv.ANTHROPIC_API_KEY = credentials.ANTHROPIC_API_KEY;
    }
    if (credentials.ANTHROPIC_BASE_URL) {
      isolatedEnv.ANTHROPIC_BASE_URL = credentials.ANTHROPIC_BASE_URL;
    }
    if (credentials.GEMINI_API_KEY) {
      isolatedEnv.GEMINI_API_KEY = credentials.GEMINI_API_KEY;
    }
    if (credentials.OPENROUTER_API_KEY) {
      isolatedEnv.OPENROUTER_API_KEY = credentials.OPENROUTER_API_KEY;
    }

    if (!isolatedEnv.ANTHROPIC_API_KEY && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }

  return isolatedEnv;
}

export function getCredential(key: keyof ClaudeMemEnv): string | undefined {
  const env = loadClaudeMemEnv();
  return env[key];
}

export function hasAnthropicApiKey(): boolean {
  const env = loadClaudeMemEnv();
  return !!env.ANTHROPIC_API_KEY;
}

export function getAuthMethodDescription(): string {
  if (hasAnthropicApiKey()) {
    return 'API key (from ~/.claude-mem/.env)';
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return 'Claude Code OAuth token (from parent process)';
  }
  return 'Claude Code CLI (subscription billing)';
}


import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { logger } from '../utils/logger.js';
import { paths } from './paths.js';
import {
  readClaudeOAuthToken,
  writeStaleMarker,
  clearStaleMarker,
  type OAuthTokenResult,
} from './oauth-token.js';

// Resolved lazily so tests (and any rare runtime path-overrides) can target a
// temp file via CLAUDE_MEM_ENV_FILE without depending on module-load order.
// Production callers see the canonical ~/.claude-mem/.env path through
// paths.envFile() unchanged.
export function envFilePath(): string {
  return process.env.CLAUDE_MEM_ENV_FILE ?? paths.envFile();
}

/** @deprecated Prefer envFilePath(); kept as a snapshot for back-compat. */
export const ENV_FILE_PATH = envFilePath();

const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',       // Issue #733: Prevent auto-discovery from project .env files
  'ANTHROPIC_AUTH_TOKEN',    // Same leak risk as ANTHROPIC_API_KEY; a token inherited from the
                             // shell would otherwise short-circuit OAuth lookup at spawn time.
                             // The fresh token from ~/.claude-mem/.env is re-injected below
                             // when explicit gateway credentials are configured.
  'ANTHROPIC_BASE_URL',      // Issue #2375: same leak class as AUTH_TOKEN. A leaked BASE_URL
                             // alone (no token) was enough to trigger the OAuth-skip path,
                             // sending the subprocess to a proxy with no credentials.
                             // Re-injected from ~/.claude-mem/.env when configured.
  'CLAUDECODE',              // Prevent "cannot be launched inside another Claude Code session" error
  'CLAUDE_CODE_OAUTH_TOKEN', // Issue #2215: prevent stale parent-process token from leaking into
                             // isolated env. The fresh token is read from the keychain at spawn
                             // time by buildIsolatedEnvWithFreshOAuth().
];

export interface ClaudeMemEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  // Corporate-proxy / custom-CA passthrough (issue: behind Zscaler/EANDIS-style MITM
  // proxies the daemon can't reach api.anthropic.com because session proxy + CA env
  // are stripped by env-sanitizer. Declaring them here is the explicit opt-in.)
  HTTPS_PROXY?: string;
  HTTP_PROXY?: string;
  NO_PROXY?: string;
  SSL_CERT_FILE?: string;
  REQUESTS_CA_BUNDLE?: string;
  CURL_CA_BUNDLE?: string;
  NODE_EXTRA_CA_CERTS?: string;
}

/**
 * Keys in ~/.claude-mem/.env that, when set, should be propagated to the
 * worker daemon's process.env at boot. These are exactly the corporate
 * connectivity vars stripped by env-sanitizer (proxy) plus the standard
 * CA-bundle vars (so Node fetch / Python requests / curl all trust the
 * corporate root CA when running through a TLS-intercepting proxy).
 *
 * They are intentionally NOT read from the parent shell environment —
 * the daemon should only honor them when the operator declares them
 * explicitly in the persistent .env file. This keeps the strict default
 * (session proxy never silently latches onto the daemon) while giving
 * corporate-network users a clean configuration path.
 */
export const PROXY_AND_CA_PASSTHROUGH_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
] as const;

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

function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    '# claude-mem credentials',
    '# This file stores keys and gateway settings for the claude-mem memory agent',
    '# Edit this file or use claude-mem settings to configure',
    '',
  ];

  for (const [key, value] of Object.entries(env)) {
    if (value) {
      const needsQuotes = /[\s#=]/.test(value);
      lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function loadClaudeMemEnv(): ClaudeMemEnv {
  const envFile = envFilePath();
  if (!existsSync(envFile)) {
    return {};
  }

  try {
    const content = readFileSync(envFile, 'utf-8');
    const parsed = parseEnvFile(content);

    const result: ClaudeMemEnv = {};
    if (parsed.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    if (parsed.ANTHROPIC_BASE_URL) result.ANTHROPIC_BASE_URL = parsed.ANTHROPIC_BASE_URL;
    if (parsed.ANTHROPIC_AUTH_TOKEN) result.ANTHROPIC_AUTH_TOKEN = parsed.ANTHROPIC_AUTH_TOKEN;
    if (parsed.GEMINI_API_KEY) result.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    if (parsed.OPENROUTER_API_KEY) result.OPENROUTER_API_KEY = parsed.OPENROUTER_API_KEY;
    for (const key of PROXY_AND_CA_PASSTHROUGH_KEYS) {
      const value = parsed[key];
      if (value) (result as Record<string, string>)[key] = value;
    }

    return result;
  } catch (error: unknown) {
    logger.warn('ENV', 'Failed to load .env file', { path: envFile }, error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

export function saveClaudeMemEnv(env: ClaudeMemEnv): void {
  const envFile = envFilePath();
  let existing: Record<string, string> = {};
  try {
    if (!existsSync(paths.dataDir())) {
      mkdirSync(paths.dataDir(), { recursive: true, mode: 0o700 });
    }
    chmodSync(paths.dataDir(), 0o700);

    existing = existsSync(envFile)
      ? parseEnvFile(readFileSync(envFile, 'utf-8'))
      : {};
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger.error('ENV', 'Failed to set up env directory or read existing env', {}, normalizedError);
    throw normalizedError;
  }

  const updated: Record<string, string> = { ...existing };

  if (env.ANTHROPIC_API_KEY !== undefined) {
    if (env.ANTHROPIC_API_KEY) {
      updated.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    } else {
      delete updated.ANTHROPIC_API_KEY;
    }
  }
  if (env.ANTHROPIC_BASE_URL !== undefined) {
    if (env.ANTHROPIC_BASE_URL) {
      updated.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
    } else {
      delete updated.ANTHROPIC_BASE_URL;
    }
  }
  if (env.ANTHROPIC_AUTH_TOKEN !== undefined) {
    if (env.ANTHROPIC_AUTH_TOKEN) {
      updated.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN;
    } else {
      delete updated.ANTHROPIC_AUTH_TOKEN;
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

  try {
    writeFileSync(envFile, serializeEnvFile(updated), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(envFile, 0o600);
  } catch (error: unknown) {
    logger.error('ENV', 'Failed to save .env file', { path: envFile }, error instanceof Error ? error : new Error(String(error)));
    throw error;
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
    if (credentials.ANTHROPIC_AUTH_TOKEN) {
      isolatedEnv.ANTHROPIC_AUTH_TOKEN = credentials.ANTHROPIC_AUTH_TOKEN;
    }
    if (credentials.GEMINI_API_KEY) {
      isolatedEnv.GEMINI_API_KEY = credentials.GEMINI_API_KEY;
    }
    if (credentials.OPENROUTER_API_KEY) {
      isolatedEnv.OPENROUTER_API_KEY = credentials.OPENROUTER_API_KEY;
    }

    // Corporate proxy / custom CA: when declared explicitly in ~/.claude-mem/.env
    // we re-inject these into the spawned subprocess env. env-sanitizer otherwise
    // strips proxy vars from the parent shell to prevent silent session-bound
    // latching; this path is the documented opt-in for corporate networks.
    for (const key of PROXY_AND_CA_PASSTHROUGH_KEYS) {
      const value = (credentials as Record<string, string | undefined>)[key];
      if (value) isolatedEnv[key] = value;
    }

    // Note: CLAUDE_CODE_OAUTH_TOKEN is intentionally NOT copied from
    // process.env here. OAuth tokens have refresh semantics that this
    // sync path cannot model — copying a parent-process token captured
    // at startup means injecting a stale token days later (issue #2215).
    // Use buildIsolatedEnvWithFreshOAuth() for spawn-time injection.
  }

  return isolatedEnv;
}

/**
 * Apply proxy and CA passthrough values from ~/.claude-mem/.env onto the
 * current process.env. This is intended to be called once at worker daemon
 * startup so that:
 *   - the worker itself (Node fetch in plugin code paths) honors the proxy
 *   - subprocess spawns that inherit process.env (chroma-mcp, hook helpers)
 *     get the proxy and CA chain without needing case-by-case wiring
 *   - explicit isolated-env builds via buildIsolatedEnv() still pick them up
 *     because they read from loadClaudeMemEnv() (file-of-record), not env.
 *
 * Existing env vars are NOT overwritten — a parent-shell value still wins.
 * This preserves the test fixtures that set explicit values via env.
 *
 * Safe to call multiple times. Returns the list of keys actually applied
 * (useful for boot-time logging).
 */
export function applyProxyAndCaFromEnvFile(): string[] {
  const credentials = loadClaudeMemEnv();
  const applied: string[] = [];
  for (const key of PROXY_AND_CA_PASSTHROUGH_KEYS) {
    const value = (credentials as Record<string, string | undefined>)[key];
    if (value && !process.env[key]) {
      process.env[key] = value;
      applied.push(key);
      // Mirror the upper/lowercase variants for proxy vars so libraries that
      // only consult one casing (curl-style lowercase vs Node's uppercase)
      // both see the value.
      if (key === 'HTTPS_PROXY' && !process.env.https_proxy) {
        process.env.https_proxy = value;
      }
      if (key === 'HTTP_PROXY' && !process.env.http_proxy) {
        process.env.http_proxy = value;
      }
      if (key === 'NO_PROXY' && !process.env.no_proxy) {
        process.env.no_proxy = value;
      }
    }
  }
  return applied;
}

/**
 * Async variant of buildIsolatedEnv() that reads the OAuth token from the
 * platform-native credential store at the moment of spawn. Use this at SDK
 * spawn-time so the worker subprocess always gets a fresh token.
 *
 * Behavior per OAuthTokenResult:
 *   - present: inject as CLAUDE_CODE_OAUTH_TOKEN env var, clear stale marker.
 *   - expired: do NOT inject. Log re-login message. Write stale marker so
 *     the session-start hook can surface the message to the user.
 *   - absent: proceed without the token. Worker may fall back to
 *     ANTHROPIC_API_KEY or other auth.
 *
 * Issue #2215: this replaces the old "copy CLAUDE_CODE_OAUTH_TOKEN from
 * process.env" path which silently injected stale tokens.
 */
export async function buildIsolatedEnvWithFreshOAuth(
  includeCredentials: boolean = true,
): Promise<Record<string, string>> {
  const isolatedEnv = buildIsolatedEnv(includeCredentials);

  // Defensive: ensure no parent-process OAuth token survives this path even
  // if BLOCKED_ENV_VARS is bypassed. Issue #2215.
  delete isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN;

  if (!includeCredentials) return isolatedEnv;

  // Custom gateway: never inject OAuth (would leak the user's Anthropic OAuth
  // token to a third-party gateway). The user must explicitly configure a
  // gateway-appropriate token in ~/.claude-mem/.env if their gateway requires
  // one. A bare BASE_URL with no token = tokenless gateway (e.g. mTLS at the
  // network boundary).
  if (isolatedEnv.ANTHROPIC_BASE_URL) {
    clearStaleMarker();
    return isolatedEnv;
  }
  // Direct API with explicit credentials: skip OAuth lookup.
  if (isolatedEnv.ANTHROPIC_API_KEY || isolatedEnv.ANTHROPIC_AUTH_TOKEN) {
    clearStaleMarker();
    return isolatedEnv;
  }

  let result: OAuthTokenResult;
  try {
    result = await readClaudeOAuthToken();
  } catch (error) {
    logger.warn(
      'OAUTH',
      'OAuth token read failed unexpectedly; proceeding without token',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
    return isolatedEnv;
  }

  switch (result.kind) {
    case 'present':
      isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN = result.token;
      logger.info('OAUTH', 'Injected fresh CLAUDE_CODE_OAUTH_TOKEN at spawn-time', {
        source: result.source,
        expiresAt: result.expiresAt,
      });
      clearStaleMarker();
      break;
    case 'expired':
      logger.warn(
        'OAUTH',
        `Refusing to inject expired CLAUDE_CODE_OAUTH_TOKEN: ${result.reason}. Re-login via Claude Desktop to refresh.`,
        { expiresAt: result.expiresAt },
      );
      writeStaleMarker(result.reason);
      break;
    case 'absent':
      logger.debug('OAUTH', `No OAuth token available: ${result.reason}`);
      // Token is absent — any prior stale-marker would have been written
      // when the token was expired, but is no longer accurate now that the
      // token is gone. Clear it so the session-start hook stops surfacing
      // a stale "expired token, re-login" warning (CodeRabbit review on PR
      // #2282).
      clearStaleMarker();
      break;
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

export function hasAnthropicAuthToken(): boolean {
  const env = loadClaudeMemEnv();
  return !!env.ANTHROPIC_AUTH_TOKEN;
}

export function getAuthMethodDescription(): string {
  if (hasAnthropicApiKey()) {
    return 'API key (from ~/.claude-mem/.env)';
  }
  if (hasAnthropicAuthToken()) {
    return 'Gateway auth token (from ~/.claude-mem/.env)';
  }
  // Note: this is a quick sync hint for logging — the authoritative OAuth
  // path is buildIsolatedEnvWithFreshOAuth() which reads the keychain at
  // spawn time. process.env may or may not carry a token here.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return 'Claude Code OAuth token (env, refreshed via keychain at spawn)';
  }
  return 'Claude Code OAuth token (read from system keychain at spawn)';
}

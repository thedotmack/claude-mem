export const ENV_PREFIXES = ['CLAUDECODE_', 'CLAUDE_CODE_'];
export const ENV_EXACT_MATCHES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'MCP_SESSION_ID',
]);

/**
 * Proxy-related env vars stripped before spawning the worker / `claude` subprocess.
 * The user's proxy config bleeding into internal AI calls causes connection failures
 * (see issues #2115, #2099). Stripped unconditionally — no opt-in flag.
 */
export const ENV_PROXY_VARS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
]);

/** Vars that start with CLAUDE_CODE_ but must be preserved for subprocess auth/tooling */
export const ENV_PRESERVE = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
]);

export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_PRESERVE.has(key)) { sanitized[key] = value; continue; }
    if (ENV_EXACT_MATCHES.has(key)) continue;
    if (ENV_PROXY_VARS.has(key)) continue;
    if (ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    sanitized[key] = value;
  }

  return sanitized;
}

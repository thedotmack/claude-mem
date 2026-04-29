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

/**
 * Env vars that must be preserved for subprocess auth/tooling.
 *
 * Two categories:
 *   - CLAUDE_CODE_* vars that would otherwise be stripped by ENV_PREFIXES.
 *     `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` were silently
 *     dropped before the fix for #2199, breaking Knowledge Agent / observer
 *     SDK runs for Bedrock and Vertex users.
 *   - Cloud provider credentials that pass through naturally today (no deny
 *     rule matches), but listing them here documents intent so future
 *     deny-list tightening doesn't quietly break Bedrock/Vertex users again.
 */
export const ENV_PRESERVE = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
  // Cloud provider switches (would be stripped by CLAUDE_CODE_ prefix). #2199.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  // AWS Bedrock credentials (pass through today; explicit for safety).
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  // Google Vertex credentials (pass through today; explicit for safety).
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
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

export const ENV_PREFIXES = ['CLAUDECODE_', 'CLAUDE_CODE_'];
export const ENV_EXACT_MATCHES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'MCP_SESSION_ID',
]);

/** Vars that start with CLAUDE_CODE_ but must be preserved for subprocess auth/tooling */
export const ENV_PRESERVE = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);

/** Cloud provider credential vars that must be forwarded to SDK subprocesses */
export const CLOUD_PROVIDER_ENV_VARS = new Set([
  // AWS (Bedrock)
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  // Google Cloud (Vertex AI)
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
]);

export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_PRESERVE.has(key)) { sanitized[key] = value; continue; }
    if (CLOUD_PROVIDER_ENV_VARS.has(key)) { sanitized[key] = value; continue; }
    if (ENV_EXACT_MATCHES.has(key)) continue;
    if (ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    sanitized[key] = value;
  }

  return sanitized;
}

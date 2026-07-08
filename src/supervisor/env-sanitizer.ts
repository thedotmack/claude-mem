// Filters CLAUDE_CODE_* (and CLAUDECODE_*) unless explicitly preserved in
// ENV_PRESERVE. This is layer 2 of defense for #2357 (CLAUDE_CODE_EFFORT_LEVEL
// / CLAUDE_CODE_ALWAYS_ENABLE_EFFORT leaking into the SDK subprocess) — layer 1
// is BLOCKED_ENV_VARS in EnvManager.ts. Do NOT add the EFFORT_* vars to
// ENV_PRESERVE: preserving them would defeat the strip.
import { loadClaudeMemEnv, PROXY_AND_CA_PASSTHROUGH_KEYS } from '../shared/EnvManager.js';

export const ENV_PREFIXES = ['CLAUDECODE_', 'CLAUDE_CODE_'];
export const ENV_EXACT_MATCHES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'MCP_SESSION_ID',
]);

export const ENV_PROXY_AND_CA_VARS = new Set([
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
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
]);

export const ENV_PRESERVE = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
]);

const LOWERCASE_PROXY_MIRRORS: Record<string, string> = {
  https_proxy: 'HTTPS_PROXY',
  http_proxy: 'HTTP_PROXY',
  no_proxy: 'NO_PROXY',
};

function isExplicitProxyOrCaPassthrough(
  configuredEnv: ReturnType<typeof loadClaudeMemEnv>,
  key: string,
  value: string,
): boolean {
  const envKey = LOWERCASE_PROXY_MIRRORS[key] ?? key;
  if (!PROXY_AND_CA_PASSTHROUGH_KEYS.includes(envKey as typeof PROXY_AND_CA_PASSTHROUGH_KEYS[number])) {
    return false;
  }

  const configured = configuredEnv[envKey as keyof ReturnType<typeof loadClaudeMemEnv>];
  return configured === value;
}

export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  let configuredEnv: ReturnType<typeof loadClaudeMemEnv> | undefined;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_PRESERVE.has(key)) { sanitized[key] = value; continue; }
    if (ENV_EXACT_MATCHES.has(key)) continue;
    if (ENV_PROXY_AND_CA_VARS.has(key)) {
      configuredEnv ??= loadClaudeMemEnv();
      if (isExplicitProxyOrCaPassthrough(configuredEnv, key, value)) sanitized[key] = value;
      continue;
    }
    if (ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    sanitized[key] = value;
  }

  return sanitized;
}

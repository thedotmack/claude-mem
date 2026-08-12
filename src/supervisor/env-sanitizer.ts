// Filters CLAUDE_CODE_* (and CLAUDECODE_*) unless explicitly preserved in
// ENV_PRESERVE. This is layer 2 of defense for #2357 (CLAUDE_CODE_EFFORT_LEVEL
// / CLAUDE_CODE_ALWAYS_ENABLE_EFFORT leaking into the SDK subprocess) — layer 1
// is BLOCKED_ENV_VARS in EnvManager.ts. Do NOT add the EFFORT_* vars to
// ENV_PRESERVE: preserving them would defeat the strip.
export const ENV_PREFIXES = ['CLAUDECODE_', 'CLAUDE_CODE_'];
export const ENV_EXACT_MATCHES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'MCP_SESSION_ID',
]);

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
  'npm_config_noproxy',
]);

export const ENV_PRESERVE = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  ...ENV_PROXY_VARS,
]);

export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_PRESERVE.has(key)) { sanitized[key] = value; continue; }
    if (ENV_EXACT_MATCHES.has(key)) continue;
    if (ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Python / venv keys that poison hermetic `uvx --python …` children when the
 * worker itself was launched from an activated virtualenv (#3552).
 *
 * `uvx` installs chromadb into its own cache, but CPython still honours
 * `VIRTUAL_ENV` / `PYTHONPATH` / `PYTHONHOME` from the parent, so a foreign
 * `numpy` (wrong ABI) can win and chroma-mcp prewarm fails silently.
 */
export const FOREIGN_PYTHON_ENV_KEYS = [
  'VIRTUAL_ENV',
  'VIRTUAL_ENV_PROMPT',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUSERBASE',
  'PYTHONSTARTUP',
  '__PYVENV_LAUNCHER__',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_PROMPT_MODIFIER',
  'CONDA_PYTHON_EXE',
  'CONDA_SHLVL',
] as const;

const FOREIGN_PYTHON_ENV_KEY_SET = new Set<string>(FOREIGN_PYTHON_ENV_KEYS);

function normalizePathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function isForeignPythonPathEntry(entry: string, roots: string[]): boolean {
  const normalized = normalizePathForCompare(entry);
  if (!normalized) return false;

  for (const root of roots) {
    const normalizedRoot = normalizePathForCompare(root);
    if (
      normalized === normalizedRoot
      || normalized.startsWith(`${normalizedRoot}/`)
    ) {
      return true;
    }
  }

  // Heuristic for shells that put venv Scripts/bin on PATH without VIRTUAL_ENV.
  return /(^|\/)(\.?venv|virtualenv)(\/.*)?\/(scripts|bin)$/i.test(normalized)
    || /(^|\/)(\.?venv|virtualenv)$/i.test(normalized);
}

/**
 * Strip foreign Python / conda activation state and matching PATH prefixes so
 * `uvx --python N` children resolve packages from uv's cache only (#3552).
 *
 * Does not touch UV_* cache/config vars — those belong to the hermetic tool.
 */
export function stripForeignPythonEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  const roots: string[] = [];

  for (const key of ['VIRTUAL_ENV', 'CONDA_PREFIX'] as const) {
    const value = cleaned[key];
    if (value) roots.push(value);
  }

  for (const key of FOREIGN_PYTHON_ENV_KEYS) {
    delete cleaned[key];
  }

  const pathKey = Object.keys(cleaned).find((key) => key.toLowerCase() === 'path');
  if (!pathKey || cleaned[pathKey] === undefined) {
    return cleaned;
  }

  const sep = platform === 'win32' ? ';' : ':';
  const filtered = cleaned[pathKey]
    .split(sep)
    .filter(Boolean)
    .filter((entry) => !isForeignPythonPathEntry(entry, roots));

  cleaned[pathKey] = filtered.join(sep);
  return cleaned;
}

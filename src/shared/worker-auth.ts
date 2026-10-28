import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

/**
 * Owner-scoped worker API token.
 *
 * Loopback TCP origin is not proof of the owning OS user: any other local
 * account can connect to 127.0.0.1:<port>. Sensitive worker routes therefore
 * require a shared secret that lives in <DATA_DIR>/worker-auth-token with
 * mode 0600 — only the owning user can read it, so presenting it proves the
 * caller runs as that user. The worker creates the file on first use and
 * reuses it afterwards, so every first-party client (hooks, CLI, MCP
 * transports, integrations) converges on the same secret.
 *
 * Overrides:
 * - CLAUDE_MEM_WORKER_AUTH_TOKEN: use this token instead of the file. For
 *   environments where the data dir is not shared between caller and worker
 *   (containers, remote shells) and for tests.
 * - CLAUDE_MEM_WORKER_AUTH=off: disable the guard entirely. Escape hatch for
 *   single-user machines and test suites; file/env only, never HTTP-writable.
 */
export const WORKER_AUTH_TOKEN_ENV = 'CLAUDE_MEM_WORKER_AUTH_TOKEN';
export const WORKER_AUTH_DISABLE_ENV = 'CLAUDE_MEM_WORKER_AUTH';
export const WORKER_AUTH_TOKEN_FILENAME = 'worker-auth-token';

// 0600: the token is a bearer credential for everything the owner can do.
const TOKEN_FILE_MODE = 0o600;

let cachedToken: string | null | undefined;

export function workerAuthDisabled(): boolean {
  return (process.env[WORKER_AUTH_DISABLE_ENV] ?? '').trim().toLowerCase() === 'off';
}

export function workerAuthTokenPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, WORKER_AUTH_TOKEN_FILENAME);
}

/**
 * The expected owner token, or '' when auth is disabled or no token could be
 * resolved. Callers that mount a guard must treat '' as fail-closed; callers
 * that attach credentials just send nothing.
 */
export function loadWorkerAuthToken(): string {
  if (cachedToken === undefined) {
    cachedToken = resolveWorkerAuthToken();
  }
  return cachedToken ?? '';
}

/** Test hook: re-resolve on the next call (env/DATA_DIR changed). */
export function resetWorkerAuthTokenCache(): void {
  cachedToken = undefined;
}

function resolveWorkerAuthToken(): string | null {
  if (workerAuthDisabled()) return null;

  const envToken = (process.env[WORKER_AUTH_TOKEN_ENV] ?? '').trim();
  if (envToken) return envToken;

  const tokenPath = workerAuthTokenPath();
  try {
    const existing = readFileSync(tokenPath, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable — try to create below.
  }

  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    // Exclusive create: a pre-existing file (even a symlink) wins the race, so
    // another local user cannot pre-seed the secret they would then know.
    const fd = openSync(tokenPath, 'wx', TOKEN_FILE_MODE);
    try {
      writeSync(fd, `${token}\n`);
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const raced = readFileSync(tokenPath, 'utf-8').trim();
        if (raced) return raced;
      } catch {
        // Fall through.
      }
    }
    return null;
  }
}

export function workerAuthFileExists(dataDir: string = DATA_DIR): boolean {
  return existsSync(workerAuthTokenPath(dataDir));
}

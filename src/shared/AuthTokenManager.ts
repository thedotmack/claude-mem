/**
 * Auth Token Manager - Bearer token for worker API authentication
 *
 * Manages a shared secret token stored at ~/.claude-mem/.auth-token
 * All hooks and the MCP server read this token to authenticate with the worker.
 * The worker validates it via middleware on every request (except health/readiness).
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'path';
import { DATA_DIR, ensureDir } from './paths.js';

export const AUTH_TOKEN_FILENAME = '.auth-token';

/**
 * Ensure the auth token file exists and return the token.
 * Creates a new 32-byte hex token if the file does not exist.
 * Reads and returns the existing token if it does.
 *
 * Uses exclusive-create (wx flag) to avoid TOCTOU race conditions
 * when multiple processes call this concurrently at startup.
 */
export function ensureAuthToken(): string {
  ensureDir(DATA_DIR);
  const tokenPath = join(DATA_DIR, AUTH_TOKEN_FILENAME);

  try {
    // Atomic create — fails if file already exists (EEXIST)
    const token = randomBytes(32).toString('hex');
    writeFileSync(tokenPath, token, { flag: 'wx', encoding: 'utf8' });
    chmodSync(tokenPath, 0o600);
    return token;
  } catch {
    // File already exists (race loser or subsequent call) — read it
    return readFileSync(tokenPath, 'utf8').trim();
  }
}

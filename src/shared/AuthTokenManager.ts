/**
 * Auth Token Manager - Bearer token for worker API authentication
 *
 * Manages a shared secret token stored at ~/.claude-mem/.auth-token
 * All hooks and the MCP server read this token to authenticate with the worker.
 * The worker validates it via middleware on every request (except health/readiness).
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'path';
import { DATA_DIR, ensureDir } from './paths.js';

export const AUTH_TOKEN_FILENAME = '.auth-token';

/**
 * Ensure the auth token file exists and return the token.
 * Creates a new 32-byte hex token if the file does not exist.
 * Reads and returns the existing token if it does.
 */
export function ensureAuthToken(): string {
  ensureDir(DATA_DIR);
  const tokenPath = join(DATA_DIR, AUTH_TOKEN_FILENAME);

  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }

  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, 'utf8');
  chmodSync(tokenPath, 0o600);
  return token;
}

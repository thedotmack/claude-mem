import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './paths.js';

const TOKEN_FILENAME = 'worker-auth-token';
let cachedToken: string | null = null;

/**
 * Get or generate the bearer token for worker API auth.
 * Token is stored in DATA_DIR/worker-auth-token and cached in memory.
 * All API requests must include this as: Authorization: Bearer <token>
 */
export function getAuthToken(): string {
  if (cachedToken) return cachedToken;

  const tokenPath = join(DATA_DIR, TOKEN_FILENAME);

  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (token.length >= 32) {
      cachedToken = token;
      return token;
    }
  }

  // Generate new 32-byte hex token
  const token = randomBytes(32).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  cachedToken = token;
  return token;
}

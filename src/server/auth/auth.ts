// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { organization } from 'better-auth/plugins';
import { DATA_DIR, ensureDir } from '../../shared/paths.js';

export function createAuth(database: Database) {
  ensureDir(DATA_DIR);
  return betterAuth({
    database,
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.CLAUDE_MEM_SERVER_URL ?? 'http://127.0.0.1:37777',
    basePath: '/api/auth',
    // Security: disable x-forwarded-host / x-forwarded-proto processing.
    // This worker binds to localhost; there is no trusted reverse proxy in front of it.
    // Without this, better-auth falls back to reading the base URL from those headers,
    // allowing an attacker to inject an arbitrary base URL via crafted request headers
    // (host-header injection — V-003).
    advanced: {
      trustedProxyHeaders: false,
    },
    plugins: [
      apiKey(),
      organization({
        teams: {
          enabled: true,
        },
      }),
    ],
  });
}

// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { organization } from 'better-auth/plugins';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';

ensureDir(DATA_DIR);

export const auth = betterAuth({
  database: new Database(DB_PATH),
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.CLAUDE_MEM_SERVER_URL ?? 'http://127.0.0.1:37777',
  basePath: '/api/auth',
  plugins: [
    apiKey(),
    organization({
      teams: {
        enabled: true,
      },
    }),
  ],
});

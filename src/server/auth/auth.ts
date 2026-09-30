// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { organization } from 'better-auth/plugins';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { DATA_DIR, ensureDir } from '../../shared/paths.js';

export function createAuth(database: Database) {
  ensureDir(DATA_DIR);
  return betterAuth({
    database,
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.CLAUDE_MEM_SERVER_URL ?? SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_URL'),
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
}

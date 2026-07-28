// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import type { SettingsManager } from '../../src/services/worker/SettingsManager.js';

type SettingsValidator = {
  validateSettings(settings: Record<string, string>): { valid: boolean; error?: string };
};

describe('SettingsRoutes OpenRouter base URL validation', () => {
  it('rejects non-HTTP(S) custom OpenRouter base URLs', () => {
    const routes = new SettingsRoutes({} as SettingsManager) as unknown as SettingsValidator;

    expect(routes.validateSettings({
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'ftp://example.com/v1',
    })).toEqual({
      valid: false,
      error: 'CLAUDE_MEM_OPENROUTER_BASE_URL must be an HTTP(S) URL',
    });
  });
});

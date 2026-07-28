// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';

const OPENROUTER_BASE_URL_KEY = 'CLAUDE_MEM_OPENROUTER_BASE_URL';

describe('OpenRouter custom endpoint settings surface (#3188)', () => {
  it('exposes the base URL in viewer defaults and types', () => {
    const defaultsSource = readFileSync('src/ui/viewer/constants/settings.ts', 'utf-8');
    const typesSource = readFileSync('src/ui/viewer/types.ts', 'utf-8');

    expect(defaultsSource).toContain(`${OPENROUTER_BASE_URL_KEY}: ''`);
    expect(typesSource).toContain(`${OPENROUTER_BASE_URL_KEY}?: string`);
  });

  it('renders the base URL field in the OpenRouter settings panel', () => {
    const modalSource = readFileSync('src/ui/viewer/components/ContextSettingsModal.tsx', 'utf-8');

    expect(modalSource).toContain('OpenRouter Base URL');
    expect(modalSource).toContain(`formState.${OPENROUTER_BASE_URL_KEY}`);
    expect(modalSource).toContain(`updateSetting('${OPENROUTER_BASE_URL_KEY}'`);
  });

  it('allows the worker settings API to persist the base URL', () => {
    const routeSource = readFileSync('src/services/worker/http/routes/SettingsRoutes.ts', 'utf-8');

    expect(routeSource).toContain(`'${OPENROUTER_BASE_URL_KEY}'`);
    expect(routeSource).toContain(`${OPENROUTER_BASE_URL_KEY} must be an HTTP(S) URL`);
  });

  it('surfaces custom OpenAI-compatible endpoint setup in the installer', () => {
    const installerSource = readFileSync('src/npx-cli/commands/install.ts', 'utf-8');

    expect(installerSource).toContain('Custom OpenAI-compatible endpoint');
    expect(installerSource).toContain('OpenAI-compatible base URL:');
    expect(installerSource).toContain(`openRouterSettings.${OPENROUTER_BASE_URL_KEY}`);
  });
});

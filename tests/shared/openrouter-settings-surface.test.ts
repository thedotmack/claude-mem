// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { isClaudeMemObserverBaseUrl } from '../../src/ui/viewer/utils/observer-endpoint.js';

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
    expect(modalSource).toContain('placeholder="https://openrouter.ai/api/v1"');
  });

  it('keeps the observer in the provider label', () => {
    const modalSource = readFileSync('src/ui/viewer/components/ContextSettingsModal.tsx', 'utf-8');
    expect(modalSource).toContain('OpenRouter / claude-mem observer');
  });

  it('shows the observer\'s own base URL read-only', () => {
    const modalSource = readFileSync('src/ui/viewer/components/ContextSettingsModal.tsx', 'utf-8');
    expect(modalSource).toContain('readOnly={observerManagesBaseUrl}');
    expect(modalSource).toContain('isClaudeMemObserverBaseUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)');
  });

  it('allows the worker settings API to persist the base URL', () => {
    const routeSource = readFileSync('src/services/worker/http/routes/SettingsRoutes.ts', 'utf-8');

    expect(routeSource).toContain(`'${OPENROUTER_BASE_URL_KEY}'`);
    expect(routeSource).toContain(`${OPENROUTER_BASE_URL_KEY} must be an HTTP(S) URL`);
  });
});

describe('isClaudeMemObserverBaseUrl', () => {
  it('recognizes the observer gateway', () => {
    expect(isClaudeMemObserverBaseUrl('https://cmem.ai/api/inference/v1')).toBe(true);
    expect(isClaudeMemObserverBaseUrl(' https://CMEM.ai/api/inference/v1 ')).toBe(true);
  });

  it('leaves every other endpoint editable', () => {
    for (const value of [
      undefined, '', 'https://openrouter.ai/api/v1', 'https://api.deepseek.com',
      'http://localhost:1234/v1', 'https://cmem.ai.evil.example/v1', 'not a url',
    ]) {
      expect(isClaudeMemObserverBaseUrl(value)).toBe(false);
    }
  });
});

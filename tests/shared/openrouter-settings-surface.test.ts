// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { isClaudeMemObserverBaseUrl } from '../../src/ui/viewer/utils/observer-endpoint.js';
import {
  OPENAI_COMPAT_PRESET_OPTIONS,
  openAICompatPresetOption,
} from '../../src/ui/viewer/constants/openai-compat-presets.js';
import { OPENAI_COMPAT_PRESETS } from '../../src/shared/openai-compat-presets.js';

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

describe('openai-compatible settings surface', () => {
  const modalSource = () => readFileSync('src/ui/viewer/components/ContextSettingsModal.tsx', 'utf-8');

  it('lists the provider after the claude-mem observer, never ahead of it', () => {
    const source = modalSource();
    const observer = source.indexOf('<option value="openrouter">OpenRouter / claude-mem observer</option>');
    const compat = source.indexOf('<option value="openai-compatible">');
    expect(observer).toBeGreaterThan(-1);
    expect(compat).toBeGreaterThan(observer);
  });

  it('edits the preset, base URL and model, and never the key', () => {
    const source = modalSource();
    for (const key of ['CLAUDE_MEM_OPENAI_COMPAT_PRESET', 'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL']) {
      expect(source).toContain(`updateSetting('${key}'`);
    }
    expect(source).not.toContain("updateSetting('CLAUDE_MEM_OPENAI_COMPAT_API_KEY'");

    const routeSource = readFileSync('src/services/worker/http/routes/SettingsRoutes.ts', 'utf-8');
    const writeList = routeSource.slice(routeSource.indexOf('const settingKeys = ['), routeSource.indexOf('];', routeSource.indexOf('const settingKeys = [')));
    for (const key of ['CLAUDE_MEM_OPENAI_COMPAT_PRESET', 'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL']) {
      expect(writeList).toContain(`'${key}'`);
    }
    expect(writeList).not.toContain("'CLAUDE_MEM_OPENAI_COMPAT_API_KEY'");
    expect(writeList).not.toContain("'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS'");
  });

  it('offers exactly the worker\'s presets, in the same order', () => {
    expect(OPENAI_COMPAT_PRESET_OPTIONS.map(({ id, label, baseUrl, defaultModel }) => ({ id, label, baseUrl, defaultModel })))
      .toEqual(OPENAI_COMPAT_PRESETS.map(({ id, label, baseUrl, defaultModel }) => ({ id, label, baseUrl, defaultModel })));
  });

  it('reads an unknown or blank stored preset as custom, like the worker', () => {
    expect(openAICompatPresetOption('nvidia-nimm').id).toBe('custom');
    expect(openAICompatPresetOption('').id).toBe('custom');
    expect(openAICompatPresetOption(' NVIDIA-NIM ').id).toBe('nvidia-nim');
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

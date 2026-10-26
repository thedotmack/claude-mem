// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { isClaudeMemObserverBaseUrl } from '../../src/ui/viewer/utils/observer-endpoint.js';
import {
  OPENAI_COMPAT_PRESET_OPTIONS,
  openAICompatPresetOption,
} from '../../src/ui/viewer/constants/openai-compat-presets.js';
import { OPENAI_COMPAT_PRESETS } from '../../src/shared/openai-compat-presets.js';

describe('openai-compatible settings surface', () => {
  const modalSource = () => readFileSync('src/ui/viewer/components/ContextSettingsModal.tsx', 'utf-8');

  it('lists the provider after the claude-mem observer, never ahead of it', () => {
    const source = modalSource();
    const observer = source.indexOf('<option value="openrouter">OpenRouter / claude-mem observer</option>');
    const compat = source.indexOf('<option value="openai-compatible">');
    expect(observer).toBeGreaterThan(-1);
    expect(compat).toBeGreaterThan(observer);
  });

  // Wave 3 gate R4-4: #4216 listed Codex second, above the observer. Before the
  // sweep the select was Claude, Gemini, then the observer; the bring-your-own
  // options added since come after it.
  it('lists Codex after the claude-mem observer too, keeping the pre-sweep order ahead of it', () => {
    const source = modalSource();
    const position = (value: string) => source.indexOf(`<option value="${value}">`);
    expect(position('claude')).toBeGreaterThan(-1);
    expect(position('gemini')).toBeGreaterThan(position('claude'));
    expect(position('openrouter')).toBeGreaterThan(position('gemini'));
    expect(position('codex')).toBeGreaterThan(position('openrouter'));
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

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_OPENCODE_GO_BASE_URL,
  DEFAULT_OPENCODE_GO_MODEL,
  DEFAULT_OPENCODE_ZEN_BASE_URL,
  DEFAULT_OPENCODE_ZEN_MODEL,
  SettingsDefaultsManager,
} from '../src/shared/SettingsDefaultsManager.js';
import { DEFAULT_SETTINGS } from '../src/ui/viewer/constants/settings.js';

const installSource = readFileSync(
  join(__dirname, '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

describe('OpenCode provider defaults', () => {
  it('uses the supported Go model everywhere settings are seeded', () => {
    expect(DEFAULT_OPENCODE_GO_MODEL).toBe('kimi-k3');
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENCODE_MODEL).toBe(DEFAULT_OPENCODE_GO_MODEL);
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_OPENCODE_MODEL).toBe(DEFAULT_OPENCODE_GO_MODEL);
  });

  it('keeps OpenCode Go and Zen endpoint defaults distinct', () => {
    expect(DEFAULT_OPENCODE_GO_BASE_URL).toBe('https://opencode.ai/zen/go/v1');
    expect(DEFAULT_OPENCODE_ZEN_BASE_URL).toBe('https://opencode.ai/zen/v1');
    expect(DEFAULT_OPENCODE_ZEN_MODEL).toBe('claude-haiku-4-5');
  });
});

describe('OpenCode install provider handling', () => {
  it('normalizes opencode-go and opencode-zen before writing CLAUDE_MEM_PROVIDER', () => {
    expect(installSource).toContain('function normalizeProviderChoice');
    expect(installSource).toMatch(/choice === ['"]opencode-zen['"][\s\S]{0,120}options\.opencodeFlavor = ['"]zen['"][\s\S]{0,80}return ['"]opencode['"]/);
    expect(installSource).toMatch(/choice === ['"]opencode-go['"][\s\S]{0,120}options\.opencodeFlavor = ['"]go['"][\s\S]{0,80}return ['"]opencode['"]/);
  });

  it('asks for the OpenCode flavor before the API key prompt', () => {
    const flavorPrompt = installSource.indexOf('Which OpenCode endpoint flavor do you use?');
    const apiKeyPrompt = installSource.indexOf('Paste your ${providerLabel} API key:');
    expect(flavorPrompt).toBeGreaterThan(-1);
    expect(apiKeyPrompt).toBeGreaterThan(-1);
    expect(flavorPrompt).toBeLessThan(apiKeyPrompt);
  });
});

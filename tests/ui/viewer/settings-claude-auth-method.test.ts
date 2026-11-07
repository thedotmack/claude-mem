import { describe, expect, it } from 'bun:test';
import { DEFAULT_SETTINGS } from '../../../src/ui/viewer/constants/settings.js';
import { claudeProviderOptionLabel } from '../../../src/ui/viewer/utils/claude-auth-method.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

// #4598: the viewer had no control for CLAUDE_MEM_CLAUDE_AUTH_METHOD and both
// provider dropdowns hard-coded "Claude (uses your Claude account)". The
// interactive wiring (both selects, both labels, the saved value) is covered
// by settings-claude-auth-method.browser.test.ts.

describe('claudeProviderOptionLabel', () => {
  it('labels each auth method the settings validator accepts', () => {
    expect(claudeProviderOptionLabel('subscription')).toBe('Claude (uses your Claude account)');
    expect(claudeProviderOptionLabel('api-key')).toBe('Claude (uses an API key)');
    expect(claudeProviderOptionLabel('gateway')).toBe('Claude (via a gateway)');
    expect(claudeProviderOptionLabel('cli')).toBe('Claude (via Claude Code CLI)');
  });

  it('falls back to the subscription wording for missing and unknown values', () => {
    for (const value of [undefined, '', 'bogus']) {
      expect(claudeProviderOptionLabel(value as string | undefined)).toBe('Claude (uses your Claude account)');
    }
  });
});

describe('viewer claude auth method defaults', () => {
  it('matches the worker default of subscription', () => {
    const sharedDefaults = SettingsDefaultsManager.getAllDefaults() as Record<string, string>;
    expect(sharedDefaults.CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe('subscription');
    expect((DEFAULT_SETTINGS as Record<string, string>).CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe('subscription');
  });
});

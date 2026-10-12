import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ContextSettingsModal } from '../../../src/ui/viewer/components/ContextSettingsModal.js';
import { DEFAULT_SETTINGS } from '../../../src/ui/viewer/constants/settings.js';
import type { Settings } from '../../../src/ui/viewer/types.js';
import { claudeProviderOptionLabel } from '../../../src/ui/viewer/utils/claude-auth-method.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

// #4598: the worker accepts CLAUDE_MEM_CLAUDE_AUTH_METHOD (subscription /
// api-key / gateway / cli) and SettingsRoutes whitelists it for HTTP writes,
// but the viewer had no control for it and both provider dropdowns hard-coded
// "Claude (uses your Claude account)".

const MODAL_SOURCE = readFileSync(
  new URL('../../../src/ui/viewer/components/ContextSettingsModal.tsx', import.meta.url),
  'utf8',
);

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides } as Settings;
}

/** The Advanced section renders collapsed (defaultOpen=false), so static
 * markup only proves the modal renders; the wiring checks below read the
 * component source, and the interactive flow is covered by the .browser
 * tests in CI. */
function renderModal(settings: Settings): string {
  return renderToStaticMarkup(
    <ContextSettingsModal
      isOpen={true}
      onClose={() => {}}
      onSave={() => {}}
      onRetryLoad={() => {}}
      settings={settings}
      isLoaded={true}
      loadError={null}
      isSaving={false}
      saveStatus=""
    />,
  );
}

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

describe('ContextSettingsModal auth method wiring', () => {
  it('labels the Claude option in both provider dropdowns from the auth method', () => {
    const option = '<option value="claude">{claudeProviderOptionLabel(formState.CLAUDE_MEM_CLAUDE_AUTH_METHOD)}</option>';
    expect((MODAL_SOURCE.match(new RegExp(option.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length).toBe(2);
    expect(MODAL_SOURCE).not.toContain('option value="claude">Claude (uses your Claude account)');
  });

  it('binds an auth method select in both claude branches', () => {
    expect((MODAL_SOURCE.match(/updateSetting\('CLAUDE_MEM_CLAUDE_AUTH_METHOD', e\.target\.value\)/g) ?? []).length).toBe(2);
    expect((MODAL_SOURCE.match(/value=\{formState\.CLAUDE_MEM_CLAUDE_AUTH_METHOD \|\| 'subscription'\}/g) ?? []).length).toBe(2);
    for (const method of ['subscription', 'api-key', 'gateway', 'cli']) {
      expect((MODAL_SOURCE.match(new RegExp(`<option value="${method}"`, 'g')) ?? []).length).toBe(2);
    }
  });

  it('still renders with an auth method in the settings', () => {
    expect(renderModal(baseSettings({ CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'api-key' }))).toContain('Settings');
  });
});

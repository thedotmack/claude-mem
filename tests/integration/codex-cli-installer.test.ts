import { describe, expect, it } from 'bun:test';
import {
  setTomlFeatureEnabled,
  setTomlPluginEnabled,
} from '../../src/services/integrations/CodexCliInstaller.js';

describe('Codex CLI installer config repair', () => {
  it('adds claude-mem plugin enablement when missing', () => {
    const result = setTomlPluginEnabled('model = "gpt-5.5"\n', 'claude-mem@claude-mem-local', true);

    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]');
    expect(result).toContain('enabled = true');
  });

  it('updates existing plugin enablement in place', () => {
    const input = [
      '[plugins."claude-mem@thedotmack"]',
      'enabled = true',
      '',
      '[marketplaces.claude-mem-local]',
      'source_type = "git"',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'claude-mem@thedotmack', false);

    expect(result).toContain('[plugins."claude-mem@thedotmack"]\nenabled = false');
    expect(result).toContain('[marketplaces.claude-mem-local]');
  });

  it('inserts enabled into an existing plugin section without touching the next section', () => {
    const input = [
      '[plugins."claude-mem@claude-mem-local"]',
      '',
      '[hooks.state]',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'claude-mem@claude-mem-local', true);

    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
    expect(result).toContain('[hooks.state]');
  });

  it('enables the current Codex hooks feature flag', () => {
    const input = [
      '[features]',
      'shell_snapshot = true',
      '',
      '[plugins."claude-mem@claude-mem-local"]',
      'enabled = true',
      '',
    ].join('\n');

    const result = setTomlFeatureEnabled(input, 'hooks', true);

    expect(result).toContain('[features]\nhooks = true\nshell_snapshot = true');
    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]');
    expect(result).not.toContain('codex_hooks');
  });
});

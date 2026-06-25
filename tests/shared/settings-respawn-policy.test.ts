import { describe, it, expect, afterEach } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('respawn-policy settings defaults', () => {
  afterEach(() => {
    delete process.env.CLAUDE_MEM_INVALID_OUTPUT_EXEMPT_CLASSES;
    delete process.env.CLAUDE_MEM_INVALID_OUTPUT_RESPAWN_THRESHOLD;
    delete process.env.CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS;
  });

  it('exposes the three knobs with documented defaults', () => {
    const d = SettingsDefaultsManager.getAllDefaults();
    expect(d.CLAUDE_MEM_INVALID_OUTPUT_EXEMPT_CLASSES).toBe('idle');
    expect(d.CLAUDE_MEM_INVALID_OUTPUT_RESPAWN_THRESHOLD).toBe('3');
    expect(d.CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS).toBe('60000');
  });

  it('honors env override via get()', () => {
    process.env.CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS = '90000';
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS')).toBe('90000');
  });
});

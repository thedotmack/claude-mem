import { describe, expect, it } from 'bun:test';
import { isObserverCaptureEnabled } from '../../src/shared/observer-capture.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { DEFAULT_SETTINGS } from '../../src/ui/viewer/constants/settings.js';

describe('isObserverCaptureEnabled', () => {
  it('keeps existing and explicitly enabled installs capturing', () => {
    expect(isObserverCaptureEnabled({})).toBe(true);
    expect(isObserverCaptureEnabled({ CLAUDE_MEM_OBSERVER_ENABLED: 'true' })).toBe(true);
  });

  it('defaults on in both the worker and viewer', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OBSERVER_ENABLED).toBe('true');
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_OBSERVER_ENABLED).toBe('true');
  });

  it('disables capture only for the validated false value', () => {
    expect(isObserverCaptureEnabled({ CLAUDE_MEM_OBSERVER_ENABLED: 'false' })).toBe(false);
    expect(isObserverCaptureEnabled({ CLAUDE_MEM_OBSERVER_ENABLED: 'FALSE' })).toBe(true);
    expect(isObserverCaptureEnabled({ CLAUDE_MEM_OBSERVER_ENABLED: false })).toBe(true);
  });
});

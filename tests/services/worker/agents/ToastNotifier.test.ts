/**
 * ToastNotifier Tests
 *
 * Mock Justification:
 * - node-notifier: External native notification library — mocked to capture calls without triggering OS notifications
 * - SettingsDefaultsManager: File I/O dependency — mocked to control the toast setting value
 * - process.platform: Runtime constant — overridden via Object.defineProperty for platform guard testing
 *
 * Test cases:
 * 1. Sends notification when enabled on macOS
 * 2. Does not send when disabled
 * 3. Does not send on non-macOS platforms
 * 4. Handles null title gracefully (uses fallback)
 * 5. Handles null subtitle gracefully (uses empty message)
 * 6. Does not throw when notifier errors
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// Track notify calls
const mockNotify = mock(() => {});

// Mock node-notifier before importing ToastNotifier
mock.module('node-notifier', () => ({
  default: { notify: mockNotify },
}));

// Mock logger to suppress output during tests
mock.module('../../../../src/utils/logger.js', () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

// Mock paths to avoid file system dependency
mock.module('../../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
}));

// Default: toast enabled
let mockSettingValue: string | boolean = 'true';

mock.module('../../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: mock(() => ({
      CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED: mockSettingValue,
    })),
  },
}));

// Import after mocks
import { sendObservationToast } from '../../../../src/services/worker/agents/ToastNotifier.js';

describe('ToastNotifier', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockNotify.mockClear();
    mockSettingValue = 'true';
    // Ensure platform is darwin by default for tests
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('sends notification when enabled on macOS', () => {
    mockSettingValue = 'true';

    sendObservationToast('Title', 'Subtitle');

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      title: 'Title',
      message: 'Subtitle',
      sound: false,
    });
  });

  it('does not send notification when disabled', () => {
    mockSettingValue = 'false';

    sendObservationToast('Title', 'Subtitle');

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does not send notification on non-macOS platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockSettingValue = 'true';

    sendObservationToast('Title', 'Subtitle');

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('handles null title gracefully', () => {
    mockSettingValue = 'true';

    sendObservationToast(null, 'subtitle');

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      title: 'Observation saved',
      message: 'subtitle',
      sound: false,
    });
  });

  it('handles null subtitle gracefully', () => {
    mockSettingValue = 'true';

    sendObservationToast('title', null);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      title: 'title',
      message: '',
      sound: false,
    });
  });

  it('does not throw when notifier errors', () => {
    mockSettingValue = 'true';
    mockNotify.mockImplementation(() => {
      throw new Error('notification system unavailable');
    });

    // Should not throw
    expect(() => sendObservationToast('Title', 'Subtitle')).not.toThrow();
  });
});

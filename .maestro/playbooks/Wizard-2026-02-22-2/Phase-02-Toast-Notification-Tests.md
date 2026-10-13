# Phase 02: Toast Notification Tests

This phase creates a comprehensive unit test suite for the ToastNotifier module. Tests verify the setting toggle, platform guard, error resilience, and correct notification content — ensuring the feature is robust without manual QA.

## Tasks

- [x] Create ToastNotifier unit tests:
  - Create `tests/services/worker/agents/ToastNotifier.test.ts`
  - Check existing test files in `tests/services/worker/agents/` for import patterns and test conventions before writing
  - Mock `node-notifier` using `vi.mock('node-notifier', ...)` — the mock should capture calls to `notify()`
  - Mock `SettingsDefaultsManager.loadFromFile` to control the `CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED` setting
  - Write these test cases:
    - `sends notification when enabled on macOS` — set platform to darwin, setting to 'true', call `sendObservationToast('Title', 'Subtitle')`, assert `notifier.notify` was called with matching title and message
    - `does not send notification when disabled` — set setting to 'false', call function, assert `notifier.notify` was NOT called
    - `does not send notification on non-macOS platforms` — mock `process.platform` to 'linux', set setting to 'true', call function, assert `notifier.notify` was NOT called
    - `handles null title gracefully` — call with `(null, 'subtitle')`, assert notify was called with fallback title
    - `handles null subtitle gracefully` — call with `('title', null)`, assert notify was called with empty message
    - `does not throw when notifier errors` — make `notifier.notify` throw, assert `sendObservationToast` does not throw
  - For platform mocking, use `vi.spyOn` on the `process` object or store/restore `Object.defineProperty(process, 'platform', ...)`

- [x] Run ToastNotifier tests and fix any failures:
  - Run `npx vitest run tests/services/worker/agents/ToastNotifier.test.ts`
  - Fix any test failures — adjust mocking strategy if needed
  - Ensure all 6 test cases pass

- [x] Run the full test suite to verify no regressions:
  - Note: 24 pre-existing test failures exist (logger-usage-standards, worker-spawn, integration tests, etc.) — none related to ToastNotifier or the toast setting
  - Run `npx vitest run`
  - If any pre-existing tests fail due to the new setting in SettingsDefaultsManager, update test fixtures to include `CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED: 'false'`
  - All tests must pass before completing this phase

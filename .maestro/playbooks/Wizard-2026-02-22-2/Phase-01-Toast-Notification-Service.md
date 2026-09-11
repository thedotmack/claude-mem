# Phase 01: Toast Notification Service — Foundation + Working Feature

This phase installs `node-notifier`, creates the toast notification module, adds a settings toggle, and wires everything into the observation save pipeline. By the end, saving an observation with `CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED=true` in `~/.claude-mem/settings.json` will produce a native macOS notification showing the observation's title and subtitle.

## Tasks

- [x] Install node-notifier dependency:
  - Run `npm install node-notifier`
  - Run `npm install --save-dev @types/node-notifier`
  - Verify both appear in package.json (dependencies and devDependencies respectively)
  - *Completed: node-notifier@10.0.1 in dependencies, @types/node-notifier@8.0.5 in devDependencies*

- [x] Add toast notifications setting to SettingsDefaultsManager:
  - Open `src/shared/SettingsDefaultsManager.ts`
  - Add `CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED: string;` to the `SettingsDefaults` interface, in the "Feature Toggles" section (near `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED`)
  - Add `CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED: 'false',` to the `DEFAULTS` object in the same section
  - Add a comment: `// macOS toast notifications for saved observations`
  - *Completed: Added to interface, DEFAULTS object, SettingsRoutes settingKeys list, and boolean validation list*

- [x] Create the ToastNotifier functional module:
  - Create `src/services/worker/agents/ToastNotifier.ts`
  - Follow the exact pattern of `src/services/worker/agents/ObservationBroadcaster.ts` (functional module, not a class)
  - Import `node-notifier`, the logger from `../../../utils/logger.js`, `SettingsDefaultsManager` from `../../../shared/SettingsDefaultsManager.js`, and `USER_SETTINGS_PATH` from `../../../shared/paths.js`
  - Export a single function `sendObservationToast(title: string | null, subtitle: string | null): void` that:
    1. Returns immediately if `process.platform !== 'darwin'` (macOS only)
    2. Loads settings via `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)`
    3. Checks `CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED` — return if not `'true'` (handle both string `'true'` and boolean `true`)
    4. Calls `notifier.notify()` with `{ title: title || 'Observation saved', message: subtitle || '', sound: false }`
    5. Wraps the entire function body in try/catch — log errors via `logger.warn('TOAST', ...)` but NEVER throw (fire-and-forget, must not crash the pipeline)
  - Add a JSDoc header matching the style of ObservationBroadcaster.ts
  - *Completed: ToastNotifier.ts created following ObservationBroadcaster pattern with all specified behaviors*

- [x] Wire ToastNotifier into the observation broadcast pipeline:
  - Open `src/services/worker/agents/ResponseProcessor.ts`
  - Add import: `import { sendObservationToast } from './ToastNotifier.js';`
  - In the `syncAndBroadcastObservations()` function, inside the `for` loop that iterates observations, add a call to `sendObservationToast(obs.title, obs.subtitle)` right after the existing `broadcastObservation(worker, {...})` call (around line 247)
  - This follows the same fire-and-forget pattern as the Chroma sync and folder CLAUDE.md updates
  - *Completed: Import added and sendObservationToast() called right after broadcastObservation() in the for loop*

- [x] Build the project and verify compilation:
  - Run `npm run build-and-sync`
  - Verify the build completes without errors
  - If there are TypeScript or build errors, fix them and rebuild
  - *Completed: Build succeeded, binary compiled (60.5 MB), marketplace synced, worker restarted and healthy*

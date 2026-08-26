// SPDX-License-Identifier: Apache-2.0

export type InstallRuntimeId = 'worker' | 'server';

/**
 * Normalize the user-supplied `--runtime <value>` flag to a canonical runtime
 * id. Accepts the legacy alias `server-beta` (what existing scripts emit) in
 * addition to the canonical `server`, and the default `worker`. Returns null
 * for an unknown value so the caller can fail fast with a clear error.
 */
export function normalizeRuntimeFlag(value: string | undefined): InstallRuntimeId | null {
  if (value === undefined) return 'worker';
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'worker') return 'worker';
  if (normalized === 'server' || normalized === 'server-beta') return 'server';
  return null;
}

// Phase 1d back-compat: also clear the legacy CLAUDE_MEM_SERVER_BETA_*
// settings keys so an uninstall fully tears down installs done before the
// rename.
export const SERVER_RUNTIME_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'CLAUDE_MEM_RUNTIME',
  'CLAUDE_MEM_SERVER_URL',
  'CLAUDE_MEM_SERVER_API_KEY',
  'CLAUDE_MEM_SERVER_PROJECT_ID',
  'CLAUDE_MEM_SERVER_BETA_URL',
  'CLAUDE_MEM_SERVER_BETA_API_KEY',
  'CLAUDE_MEM_SERVER_BETA_PROJECT_ID',
]);

// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — pure planning logic for the server runtime install/uninstall paths
// (#2543, #2568).
//
// The actual side effects of `claude-mem install --runtime server` (bringing up
// the Docker stack, generating an API key against a live database, injecting an
// IDE MCP config) cannot run in a unit-test sandbox. To keep the decision logic
// honest and covered, the *planning* — argument resolution, which steps run,
// what the MCP config should look like, which scopes a key gets — lives here as
// pure functions with no I/O. install.ts / uninstall.ts execute the plan.
//
// This module deliberately imports only the shared scope constant and the MCP
// integration types; it performs no filesystem or network access.

import { DEFAULT_LOCAL_API_KEY_SCOPES } from '../../server/auth/sqlite-api-key-service.js';

export type InstallRuntimeId = 'worker' | 'server-beta';

/**
 * Normalize the user-supplied `--runtime <value>` flag to a canonical runtime
 * id. Accepts the friendly alias `server` (what an operator types) in addition
 * to the canonical `server-beta`, and the default `worker`. Returns null for an
 * unknown value so the caller can fail fast with a clear error.
 */
export function normalizeRuntimeFlag(value: string | undefined): InstallRuntimeId | null {
  if (value === undefined) return 'worker';
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'worker') return 'worker';
  if (normalized === 'server' || normalized === 'server-beta') return 'server-beta';
  return null;
}

export interface ServerRuntimeInstallInputs {
  /**
   * Base URL the hooks / IDE MCP config should target for the server runtime,
   * e.g. `http://127.0.0.1:37877`. Required: the server runtime is useless
   * without a reachable endpoint.
   */
  serverBaseUrl: string;
  /**
   * Whether the operator has Postgres configured (CLAUDE_MEM_SERVER_DATABASE_URL
   * present). API-key generation requires a live database; without it we plan to
   * skip key gen and tell the operator to run `server keys rotate` after they
   * configure the DB.
   */
  hasDatabaseUrl: boolean;
  /**
   * Whether to bring up the bundled Docker stack (pg + redis/valkey). When the
   * operator points at an externally-managed server they pass false.
   */
  manageDockerStack?: boolean;
}

export interface ServerRuntimeInstallPlan {
  runtime: 'server-beta';
  /** Settings to persist to ~/.claude-mem/settings.json so hooks select the server runtime. */
  settings: { CLAUDE_MEM_RUNTIME: 'server-beta'; CLAUDE_MEM_SERVER_BETA_URL: string };
  /** Bring up the bundled pg + redis/valkey compose stack. */
  bringUpDockerStack: boolean;
  /** Generate an initial API key (only possible once the DB is reachable). */
  generateApiKey: boolean;
  /** Scopes the generated key receives — the same default the local routes require. */
  apiKeyScopes: readonly string[];
  /** Inject the IDE MCP config pointed at the server. */
  injectIdeMcpConfig: boolean;
  /** The MCP server config object the IDE injection should write. */
  mcpServerConfig: ServerRuntimeMcpConfig;
  /** Human-readable notes surfaced to the operator (e.g. why key gen was skipped). */
  notes: string[];
}

export interface ServerRuntimeMcpConfig {
  /** Transport type — the server runtime is reachable over HTTP, not stdio. */
  type: 'http';
  /** The /mcp endpoint on the server runtime. */
  url: string;
}

/**
 * Build the deterministic plan for `claude-mem install --runtime server`.
 *
 * This is the unit-testable core of #2543. It never touches the worker-only
 * install path: it only describes the server-runtime steps. The caller is
 * responsible for executing the plan (Docker up, key gen, MCP write) and for
 * NOT invoking the worker autostart when runtime === 'server-beta'.
 */
export function planServerRuntimeInstall(inputs: ServerRuntimeInstallInputs): ServerRuntimeInstallPlan {
  const serverBaseUrl = inputs.serverBaseUrl.trim();
  if (!serverBaseUrl) {
    throw new Error('planServerRuntimeInstall requires a non-empty serverBaseUrl');
  }
  const manageDockerStack = inputs.manageDockerStack ?? true;
  const notes: string[] = [];

  if (!inputs.hasDatabaseUrl) {
    notes.push(
      'CLAUDE_MEM_SERVER_DATABASE_URL is not set; skipping API key generation. '
        + 'Run `npx claude-mem server keys rotate` after Postgres is reachable to provision a hook key.',
    );
  }

  return {
    runtime: 'server-beta',
    settings: {
      CLAUDE_MEM_RUNTIME: 'server-beta',
      CLAUDE_MEM_SERVER_BETA_URL: serverBaseUrl,
    },
    bringUpDockerStack: manageDockerStack,
    generateApiKey: inputs.hasDatabaseUrl,
    apiKeyScopes: DEFAULT_LOCAL_API_KEY_SCOPES,
    injectIdeMcpConfig: true,
    mcpServerConfig: buildServerRuntimeMcpConfig(serverBaseUrl),
    notes,
  };
}

/**
 * The MCP server config an IDE should use to reach the server runtime. The
 * server mounts its MCP endpoint at `<baseUrl>/mcp` over HTTP (vs. the worker's
 * stdio transport). Trailing slashes on the base URL are normalized so we never
 * emit `http://host//mcp`.
 */
export function buildServerRuntimeMcpConfig(serverBaseUrl: string): ServerRuntimeMcpConfig {
  const trimmed = serverBaseUrl.trim().replace(/\/+$/, '');
  return {
    type: 'http',
    url: `${trimmed}/mcp`,
  };
}

// ---------------------------------------------------------------------------
// Uninstall planning (#2568)
// ---------------------------------------------------------------------------

export interface ServerRuntimeUninstallInputs {
  /** The runtime recorded in settings (CLAUDE_MEM_RUNTIME). */
  selectedRuntime: InstallRuntimeId;
  /** Whether the bundled Docker stack appears to be managed locally. */
  dockerStackManaged?: boolean;
}

export interface ServerRuntimeUninstallPlan {
  /** True when the server-runtime teardown steps should run at all. */
  isServerRuntime: boolean;
  /** Stop + remove the bundled pg + redis/valkey compose stack. */
  tearDownDockerStack: boolean;
  /** Clear the server-runtime settings keys so a later install starts clean. */
  clearServerSettings: boolean;
  /** Settings keys to delete during teardown. */
  settingsKeysToClear: readonly string[];
}

export const SERVER_RUNTIME_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'CLAUDE_MEM_RUNTIME',
  'CLAUDE_MEM_SERVER_BETA_URL',
  'CLAUDE_MEM_SERVER_BETA_API_KEY',
  'CLAUDE_MEM_SERVER_BETA_PROJECT_ID',
]);

/**
 * Decide what `claude-mem uninstall` must do for the server runtime (#2568).
 *
 * The worker uninstall path is unchanged: when the selected runtime is `worker`
 * this returns `isServerRuntime: false` and no server teardown steps. Only when
 * the operator installed the server runtime do we plan to stop/remove the stack
 * and clear server config.
 */
export function planServerRuntimeUninstall(
  inputs: ServerRuntimeUninstallInputs,
): ServerRuntimeUninstallPlan {
  const isServerRuntime = inputs.selectedRuntime === 'server-beta';
  if (!isServerRuntime) {
    return {
      isServerRuntime: false,
      tearDownDockerStack: false,
      clearServerSettings: false,
      settingsKeysToClear: [],
    };
  }
  return {
    isServerRuntime: true,
    tearDownDockerStack: inputs.dockerStackManaged ?? false,
    clearServerSettings: true,
    settingsKeysToClear: SERVER_RUNTIME_SETTINGS_KEYS,
  };
}

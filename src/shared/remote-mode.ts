/**
 * Remote mode (CMEM Pro in ephemeral containers).
 *
 * A Claude Code cloud container (claude.ai "Claude Code on the web") starts
 * from a blank filesystem on every session: no ~/.claude-mem/settings.json, no
 * local corpus, no browser to run an interactive pairing flow. The only
 * configuration channel the user controls is the environment settings of the
 * cloud environment, which become plain env vars inside the container — and
 * SettingsDefaultsManager already lets any settings key be overridden by an
 * identically named env var.
 *
 * Remote mode collapses the full Pro connection (cloud sync + Pro inference
 * gateway) into two pre-filled credentials so the environment settings block
 * stays small:
 *
 *   CLAUDE_MEM_REMOTE_MODE=true        (recommended; 'auto' activates on creds)
 *   CLAUDE_MEM_PRO_TOKEN=cm_pro_...    (cmem.ai setup token)
 *   CLAUDE_MEM_PRO_USER_ID=<uuid>      (cmem.ai account user id)
 *
 * When active, applyRemoteModeDerivations() expands those into the existing
 * settings keys — cloud sync token/user/hub, OpenRouter provider pointed at
 * the cmem.ai inference gateway, Chroma off (ephemeral disk, no uv), and a
 * recognizable device name — but ONLY where the user has not already set a
 * value explicitly. Every derived key can still be overridden individually
 * through env or settings.json.
 *
 * IMPORTANT process-consistency constraint: the worker daemon is spawned
 * through sanitizeEnv(), which strips the CLAUDE_CODE_* prefix — so
 * CLAUDE_CODE_REMOTE (the container marker) is visible to hook processes but
 * NOT to the worker. Activation therefore keys ONLY off CLAUDE_MEM_* values,
 * which survive every spawn path; CLAUDE_CODE_REMOTE is exported for
 * diagnostics/UI use only and must never gate behavior that both hooks and
 * the worker need to agree on.
 */

import type { SettingsDefaults } from './SettingsDefaultsManager.js';

export const REMOTE_DEFAULT_PRO_ORIGIN = 'https://cmem.ai';
export const REMOTE_DEFAULT_HUB_URL = 'https://sync.cmem.ai';
export const REMOTE_DEVICE_NAME = 'Claude Code cloud';
export const REMOTE_INFERENCE_MODEL = 'cmem-observer';
export const REMOTE_BOOTSTRAP_TIMEOUT_DEFAULT_MS = 20000;

/**
 * Container marker set by Claude Code cloud sessions. Diagnostics only — see
 * the header comment for why activation must not depend on it.
 */
export function isClaudeCodeRemoteContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.CLAUDE_CODE_REMOTE ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * Env-first read. SearchRoutes' settings cache deliberately loads with
 * applyEnvOverrides=false, and remote-mode credentials arrive as env vars in
 * the target environment — so every activation check must consult process.env
 * before the settings object (same precedence as SettingsDefaultsManager.get).
 */
function effectiveValue(
  settings: Partial<SettingsDefaults>,
  key: keyof SettingsDefaults,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env[key] ?? settings[key] ?? '';
}

/**
 * Whether remote mode is active for this process.
 *
 *   CLAUDE_MEM_REMOTE_MODE='false' → never.
 *   CLAUDE_MEM_REMOTE_MODE='true'  → active when both Pro credentials are set.
 *   anything else ('auto', unset)  → same as 'true': the credential pair IS
 *     the switch. The pair is new and documented as remote-only; a local
 *     install configured by the installer/cloud-sync skill never sets it.
 */
export function isRemoteModeActive(
  settings: Partial<SettingsDefaults>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = effectiveValue(settings, 'CLAUDE_MEM_REMOTE_MODE', env).trim().toLowerCase();
  if (flag === 'false') return false;
  return (
    effectiveValue(settings, 'CLAUDE_MEM_PRO_TOKEN', env).trim() !== '' &&
    effectiveValue(settings, 'CLAUDE_MEM_PRO_USER_ID', env).trim() !== ''
  );
}

/** Bounded catch-up budget for the cold-start pull at first context inject. */
export function remoteBootstrapTimeoutMs(
  settings: Partial<SettingsDefaults>,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = effectiveValue(settings, 'CLAUDE_MEM_REMOTE_BOOTSTRAP_TIMEOUT_MS', env).trim();
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return REMOTE_BOOTSTRAP_TIMEOUT_DEFAULT_MS;
  return parsed;
}

/**
 * Expand the Pro credential pair into the existing connection keys.
 *
 * Called by SettingsDefaultsManager.loadFromFile on the effective-settings
 * path (applyEnvOverrides=true) AFTER env merging, so `settings` already
 * carries env values. Derivations are in-memory only — they are never written
 * back to settings.json (the token stays wherever the user put it: the
 * environment settings of the cloud environment).
 *
 * Precedence per key: an explicit env var always wins (checked via
 * process.env), and a value that differs from the shipped default is treated
 * as user-set and left alone. Only untouched keys are derived.
 */
export function applyRemoteModeDerivations(
  settings: SettingsDefaults,
  defaults: SettingsDefaults,
  env: NodeJS.ProcessEnv = process.env
): SettingsDefaults {
  if (!isRemoteModeActive(settings, env)) return settings;

  const result = { ...settings };
  const token = effectiveValue(settings, 'CLAUDE_MEM_PRO_TOKEN', env).trim();
  const userId = effectiveValue(settings, 'CLAUDE_MEM_PRO_USER_ID', env).trim();
  const origin = (
    effectiveValue(settings, 'CLAUDE_MEM_PRO_ORIGIN', env).trim() || REMOTE_DEFAULT_PRO_ORIGIN
  ).replace(/\/+$/, '');

  const untouched = (key: keyof SettingsDefaults): boolean =>
    env[key] === undefined && result[key] === defaults[key];

  // Cloud sync: the three activation keys DatabaseManager gates on.
  if (result.CLAUDE_MEM_CLOUD_SYNC_TOKEN === '') result.CLAUDE_MEM_CLOUD_SYNC_TOKEN = token;
  if (result.CLAUDE_MEM_CLOUD_SYNC_USER_ID === '') result.CLAUDE_MEM_CLOUD_SYNC_USER_ID = userId;
  if (result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL.trim() === '') {
    result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL = REMOTE_DEFAULT_HUB_URL;
  }
  // Default device name is hostname() — a random container id in the cloud.
  // Make the Devices panel legible; each container still mints its own
  // device id (ephemeral containers must never share a sync cursor).
  if (untouched('CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME')) {
    result.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME = REMOTE_DEVICE_NAME;
  }

  // Observation compression via the Pro inference gateway. The container has
  // no Claude subscription auth for the SDK agent (sanitizers strip it), so
  // the OpenRouter-compatible gateway is the designed path for Pro accounts.
  if (untouched('CLAUDE_MEM_PROVIDER')) {
    result.CLAUDE_MEM_PROVIDER = 'openrouter';
  }
  if (result.CLAUDE_MEM_PROVIDER === 'openrouter') {
    const gatewayUrl = `${origin}/api/inference/v1`;
    if (result.CLAUDE_MEM_OPENROUTER_API_KEY === '') {
      result.CLAUDE_MEM_OPENROUTER_API_KEY = token;
    }
    if (result.CLAUDE_MEM_OPENROUTER_BASE_URL.trim() === '') {
      result.CLAUDE_MEM_OPENROUTER_BASE_URL = gatewayUrl;
    }
    // The gateway model alias only exists on the cmem.ai gateway — never
    // derive it for a user-supplied base URL.
    if (
      result.CLAUDE_MEM_OPENROUTER_BASE_URL === gatewayUrl &&
      untouched('CLAUDE_MEM_OPENROUTER_MODEL')
    ) {
      result.CLAUDE_MEM_OPENROUTER_MODEL = REMOTE_INFERENCE_MODEL;
    }
  }

  // Chroma pulls a Python toolchain via uv and embeds locally — wasted work on
  // a disk that is reclaimed when the session ends. SQLite search still works,
  // and cloud search lives on cmem.ai. Opt back in with
  // CLAUDE_MEM_CHROMA_ENABLED=true in the environment settings.
  if (untouched('CLAUDE_MEM_CHROMA_ENABLED')) {
    result.CLAUDE_MEM_CHROMA_ENABLED = 'false';
  }

  return result;
}

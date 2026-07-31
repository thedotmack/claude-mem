import { existsSync, readFileSync } from 'fs';
import { paths } from './paths.js';
import { parseJsonWithBom, writeJsonFileAtomic } from './atomic-json.js';
import { loadClaudeMemEnv, saveClaudeMemEnv } from './EnvManager.js';

/**
 * Kimi Code observer provider configuration.
 *
 * Moonshot's Kimi for Coding exposes an Anthropic-compatible endpoint, so the
 * worker observer (Claude Agent SDK) can talk to it through the existing
 * ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY credential channel — no new provider
 * plumbing required:
 *
 *   - Both keys are already whitelisted in EnvManager's CREDENTIAL_KEYS, so
 *     buildIsolatedEnv() re-injects them from ~/.claude-mem/.env into the SDK
 *     subprocess env (and BLOCKED_ENV_VARS keeps any shell-leaked values out).
 *   - buildIsolatedEnvWithFreshOAuth() short-circuits the OAuth lookup when
 *     ANTHROPIC_BASE_URL is set (the custom-gateway branch), so the user's
 *     Anthropic OAuth token is never sent to the Kimi endpoint and nothing
 *     overwrites these variables.
 *   - sanitizeEnv() only strips CLAUDE_CODE_* / CLAUDECODE_* vars, so both
 *     keys survive the spawn pipeline intact.
 *
 * The model is pinned via the standard CLAUDE_MEM_MODEL settings key.
 */

export const KIMI_OBSERVER_BASE_URL = 'https://api.kimi.com/coding/';
export const KIMI_OBSERVER_MODEL = 'kimi-for-coding';

/**
 * Point the worker observer at Kimi's Anthropic-compatible endpoint: writes
 * ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY to ~/.claude-mem/.env and pins
 * CLAUDE_MEM_MODEL in settings.json. Existing unrelated keys in both files
 * are preserved.
 */
export function configureKimiObserver(apiKey: string, settingsPath: string = paths.settings()): void {
  saveClaudeMemEnv({
    ANTHROPIC_BASE_URL: KIMI_OBSERVER_BASE_URL,
    ANTHROPIC_API_KEY: apiKey,
  });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = parseJsonWithBom<Record<string, unknown>>(readFileSync(settingsPath, 'utf-8'));
  }
  settings.CLAUDE_MEM_MODEL = KIMI_OBSERVER_MODEL;
  writeJsonFileAtomic(settingsPath, settings);
}

/** True when the observer credentials currently point at the Kimi endpoint. */
export function isKimiObserverConfigured(): boolean {
  return loadClaudeMemEnv().ANTHROPIC_BASE_URL === KIMI_OBSERVER_BASE_URL;
}

/**
 * Remove the Kimi observer override: clears the .env credential keys only
 * when they still point at the Kimi endpoint (a user may have re-pointed
 * BASE_URL elsewhere — that is left untouched). CLAUDE_MEM_MODEL in
 * settings.json is intentionally left as-is; the user picks a new model on
 * the next install or via `claude-mem settings`.
 */
export function removeKimiObserverConfiguration(): boolean {
  const env = loadClaudeMemEnv();
  if (env.ANTHROPIC_BASE_URL !== KIMI_OBSERVER_BASE_URL) return false;

  saveClaudeMemEnv({ ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '' });
  return true;
}

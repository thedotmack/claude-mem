/**
 * Whether the Claude provider can take observer work as the Anthropic-plan
 * fallback (provider-dispatch's quota fallback). Dispatch is synchronous and
 * runs on every generator start, so this reads settings and files only: it
 * never spawns the CLI or reads the keychain. It answers "is there a Claude
 * credential to run on", not "is that credential still valid": a refused one
 * arms the 'claude' auth cooldown on its first run, and dispatch skips a
 * fallback that is itself held.
 *
 * Without it, a machine with no Claude login would move work off a provider
 * that is only briefly unavailable onto one that can never serve it.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { paths } from './paths.js';
import { parseJsonWithBom } from './atomic-json.js';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { getCredential, hasAnthropicApiKey, hasAnthropicAuthToken } from './EnvManager.js';
import { cooldownAppliesToCurrentAccount, getQuotaCooldown, isQuotaCooldownHolding, type ClaudeCredential } from './quota-cooldown.js';
import { resolveClaudeCredentialProfile } from './oauth-token.js';
import {
  CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS,
  getDependencyStatus,
  isDependencyStatusInCooldown,
} from './dependency-health.js';
import { getClaudeFallbackReadinessOverride } from './claude-fallback-readiness-override.js';

/** Whether Claude Code recorded a signed-in account in a `.claude.json`. */
function claudeJsonHasSignedInAccount(claudeJsonFile: string): boolean {
  if (!existsSync(claudeJsonFile)) return false;
  try {
    // This file holds account details: only the presence of the field is read,
    // and a parse error is never logged (its text quotes the input).
    const parsed = parseJsonWithBom<{ oauthAccount?: unknown }>(readFileSync(claudeJsonFile, 'utf-8'));
    return Boolean(parsed && typeof parsed === 'object' && parsed.oauthAccount);
  } catch {
    return false;
  }
}

/** Whether a Claude credential exists for the profile the next Claude spawn uses. */
export function hasClaudeCredentials(): boolean {
  if (hasAnthropicApiKey() || hasAnthropicAuthToken()) return true;
  return hasClaudeSubscriptionLogin();
}

/** Whether a Claude Code login (not a key) exists for the profile the next Claude spawn uses. */
export function hasClaudeSubscriptionLogin(): boolean {
  // A headless login: readClaudeOAuthToken serves this token too ('env-fallback').
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  const profile = resolveClaudeCredentialProfile(settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR);
  // Linux and Windows keep the login in the profile's credentials file; macOS
  // keeps it in the keychain, with the signed-in account recorded in
  // .claude.json (beside an explicit profile, in the home dir for the default).
  if (existsSync(join(profile.configDir, '.credentials.json'))) return true;
  const claudeJson = profile.explicitConfigDir
    ? join(profile.configDir, '.claude.json')
    : join(homedir(), '.claude.json');
  return claudeJsonHasSignedInAccount(claudeJson);
}

/**
 * The credential a Claude run held by its quota breaker may go on instead
 * (CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD), or null to wait as before.
 *
 * Only a breaker the OTHER credential armed qualifies: 'subscription' stands in
 * for a spent API key, 'api-key' (ANTHROPIC_FALLBACK_API_KEY) for a login that
 * is spent or paused by the quota guard. Once the stand-in's own run is refused,
 * the breaker re-arms untagged and this returns null: both are spent. A gateway
 * (ANTHROPIC_BASE_URL) never qualifies, so observer traffic is never routed
 * around it (nor the OAuth token sent to it).
 */
export function claudeQuotaStandIn(): ClaudeCredential | null {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  const target = settings.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD;
  if (target !== 'subscription' && target !== 'api-key') return null;
  const cooldown = getQuotaCooldown('claude');
  if (!cooldown?.auth || cooldown.auth === target || !cooldownAppliesToCurrentAccount(cooldown)) return null;
  if (getCredential('ANTHROPIC_BASE_URL')) return null;
  const isTargetReady = target === 'subscription'
    ? hasClaudeSubscriptionLogin()
    : Boolean(getCredential('ANTHROPIC_FALLBACK_API_KEY'));
  return isTargetReady ? target : null;
}

/**
 * Whether a running quota-fallback run on `standIn` may take its next batch:
 * the primary credential is still held and `standIn` still qualifies. Once the
 * primary's window elapses, or another session's success clears its breaker,
 * the run ends at its next message boundary, and the next admission probes the
 * primary through the single probe claim (tryAdmitQuotaProbe).
 */
export function claudeStandInStillServes(standIn: ClaudeCredential): boolean {
  return isQuotaCooldownHolding('claude') && claudeQuotaStandIn() === standIn;
}

function detectClaudeFallbackReadiness(): boolean {
  // A Claude CLI that just failed to start would fail the fallback the same
  // way; after the recheck window a start is the probe, as for a Claude primary.
  const cli = getDependencyStatus('claude_cli');
  if (cli?.kind === 'setup_required' && isDependencyStatusInCooldown(cli, CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS)) {
    return false;
  }
  return hasClaudeCredentials();
}

/** Whether Claude can serve as the fallback right now. */
export function canClaudeServeAsFallback(): boolean {
  return (getClaudeFallbackReadinessOverride() ?? detectClaudeFallbackReadiness)();
}

// Tests replace the check through the import-free override module; see there.
export { setClaudeFallbackReadinessForTesting } from './claude-fallback-readiness-override.js';

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

/**
 * Billing posture of the OBSERVED Claude Code session (the user's IDE session,
 * not the observer claude-mem uses to write observations).
 *
 * Closed set, kept low-cardinality for telemetry. `max`/`pro`/`team`/`enterprise`
 * come from `oauthAccount.organizationType` with the `claude_` prefix stripped;
 * any other organizationType collapses to `subscription` so an unexpected value
 * can never widen the set (documented in docs/public/telemetry.mdx).
 */
export type ObservedBilling =
  | 'max'
  | 'pro'
  | 'team'
  | 'enterprise'
  | 'subscription'
  | 'api_key'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'unknown';

type SubscriptionTier = 'max' | 'pro' | 'team' | 'enterprise';

const KNOWN_SUBSCRIPTION_TIERS = new Set<string>(['max', 'pro', 'team', 'enterprise']);

function isKnownSubscriptionTier(tier: string): tier is SubscriptionTier {
  return KNOWN_SUBSCRIPTION_TIERS.has(tier);
}

/**
 * The only `.claude.json` fields we keep. The parsed file is projected onto this
 * shape immediately after JSON.parse, so token, email, and account-id fields on
 * `oauthAccount` never exist past that line — nothing downstream can read or log them.
 */
interface ClaudeJsonBillingFields {
  oauthAccount?: { organizationType?: unknown };
  customApiKeyResponses?: { approved?: unknown };
}

export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** Keep only the billing fields; drop everything else from the parsed file. */
function projectBillingFields(parsed: unknown): ClaudeJsonBillingFields {
  if (!parsed || typeof parsed !== 'object') return {};
  const { oauthAccount, customApiKeyResponses } = parsed as {
    oauthAccount?: { organizationType?: unknown } | null;
    customApiKeyResponses?: { approved?: unknown } | null;
  };
  return {
    oauthAccount: oauthAccount ? { organizationType: oauthAccount.organizationType } : undefined,
    customApiKeyResponses: customApiKeyResponses
      ? { approved: customApiKeyResponses.approved }
      : undefined,
  };
}

function readClaudeJsonBillingFields(claudeJsonFile: string): ClaudeJsonBillingFields {
  if (!existsSync(claudeJsonFile)) return {};
  // The Stop hook has no guard around billing detection, so a corrupt
  // `.claude.json` would otherwise abort summarization for that user. We wrap
  // ONLY the read+parse: a corrupt file degrades to "no account" (the same
  // result as a missing file) and the rest of detection proceeds.
  //
  // The error text is deliberately NOT logged: a JSON.parse SyntaxError quotes
  // the offending input, and this file holds OAuth tokens. Only the error class
  // name is recorded.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(claudeJsonFile, 'utf-8'));
  } catch (error) {
    logger.debug('HOOK', 'observed-billing: could not read or parse .claude.json, treating as no account', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return {};
  }
  return projectBillingFields(parsed);
}

function isApiKeyApproved(fields: ClaudeJsonBillingFields, apiKey: string): boolean {
  const approved = fields.customApiKeyResponses?.approved;
  return Array.isArray(approved) && approved.includes(apiKey.slice(-20));
}

function organizationTier(fields: ClaudeJsonBillingFields): ObservedBilling | undefined {
  const organizationType = fields.oauthAccount?.organizationType;
  if (typeof organizationType !== 'string') return undefined;
  const tier = organizationType.replace(/^claude_/, '');
  return isKnownSubscriptionTier(tier) ? tier : 'subscription';
}

/**
 * Detection order (first match wins):
 *   1. CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY  → bedrock | vertex | foundry
 *   2. ANTHROPIC_API_KEY || ANTHROPIC_AUTH_TOKEN, and either no oauthAccount or
 *      the key is in customApiKeyResponses.approved       → api_key
 *   3. oauthAccount.organizationType                        → max | pro | team | enterprise,
 *      or subscription for any other value
 *   4. oauthAccount present || CLAUDE_CODE_OAUTH_TOKEN      → subscription
 *   5. otherwise                                            → unknown
 *
 * Runs in the hook process because it needs Claude Code's environment; the
 * worker daemon does not inherit the user's shell env.
 */
export function detectObservedBilling(
  env: NodeJS.ProcessEnv = process.env,
  claudeJsonFile: string = claudeJsonPath(env),
): ObservedBilling {
  if (isTruthyEnv(env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock';
  if (isTruthyEnv(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex';
  if (isTruthyEnv(env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry';

  const fields = readClaudeJsonBillingFields(claudeJsonFile);
  const hasAccount = !!fields.oauthAccount;

  const apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (apiKey && (!hasAccount || isApiKeyApproved(fields, apiKey))) return 'api_key';

  const tier = organizationTier(fields);
  if (tier) return tier;

  if (hasAccount || isTruthyEnv(env.CLAUDE_CODE_OAUTH_TOKEN)) return 'subscription';

  return 'unknown';
}

/**
 * Claude Code Subscription Detection
 *
 * Detects whether the user has an active Claude Code subscription by reading
 * the credentials file. This is used to determine whether to route API calls
 * through the Claude Code CLI (subscription billing) or allow direct API key
 * usage (API billing).
 *
 * @see https://github.com/thedotmack/claude-mem/issues/733
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CLAUDE_CONFIG_DIR } from './paths.js';

/**
 * Subscription types that indicate an active paid subscription.
 * Users with these subscription types should route through Claude Code CLI.
 */
const PAID_SUBSCRIPTION_TYPES = ['max', 'pro'] as const;

/**
 * Path to Claude Code credentials file
 */
const CLAUDE_CREDENTIALS_PATH = join(CLAUDE_CONFIG_DIR, '.credentials.json');

interface ClaudeCredentials {
  claudeAiOauth?: {
    subscriptionType?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

/**
 * Check if the user has an active Claude Code subscription.
 *
 * Reads ~/.claude/.credentials.json and checks the subscriptionType field.
 * Returns true if the user has a paid subscription (max, pro, etc.).
 *
 * @returns true if user has a paid Claude Code subscription, false otherwise
 */
export function hasClaudeSubscription(): boolean {
  try {
    if (!existsSync(CLAUDE_CREDENTIALS_PATH)) {
      return false;
    }

    const credentialsRaw = readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8');
    const credentials: ClaudeCredentials = JSON.parse(credentialsRaw);

    const subscriptionType = credentials?.claudeAiOauth?.subscriptionType;

    if (!subscriptionType) {
      return false;
    }

    // Check if it's a paid subscription type
    return PAID_SUBSCRIPTION_TYPES.includes(
      subscriptionType.toLowerCase() as typeof PAID_SUBSCRIPTION_TYPES[number]
    );
  } catch {
    // If we can't read or parse the file, assume no subscription
    return false;
  }
}

/**
 * Get the user's subscription type, if any.
 *
 * @returns The subscription type string, or null if not found
 */
export function getSubscriptionType(): string | null {
  try {
    if (!existsSync(CLAUDE_CREDENTIALS_PATH)) {
      return null;
    }

    const credentialsRaw = readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8');
    const credentials: ClaudeCredentials = JSON.parse(credentialsRaw);

    return credentials?.claudeAiOauth?.subscriptionType ?? null;
  } catch {
    return null;
  }
}

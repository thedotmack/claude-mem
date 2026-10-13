/**
 * The Claude auth methods the worker's settings validator accepts
 * (`SettingsRoutes.ts`): which credential the Claude provider authenticates
 * the Agent SDK with. `CLAUDE_MEM_CLAUDE_AUTH_METHOD` backs this, defaulting
 * to 'subscription' (SettingsDefaultsManager.ts).
 */
export const CLAUDE_AUTH_METHODS = ['subscription', 'api-key', 'gateway', 'cli'] as const;

export type ClaudeAuthMethod = (typeof CLAUDE_AUTH_METHODS)[number];

/** The stored default; every provider dropdown treats it (and any unknown value) as this. */
export const DEFAULT_CLAUDE_AUTH_METHOD: ClaudeAuthMethod = 'subscription';

/**
 * The Claude option label for the AI Provider / Quota Fallback dropdowns.
 * Both selects offer the same single Claude provider, so both labels read
 * from the one shared auth-method setting — "uses your Claude account" for a
 * subscription, an API key from ~/.claude-mem/.env, or a gateway endpoint —
 * instead of hard-coding the subscription wording (#4598). Unknown or missing
 * values fall back to the subscription label, the historical default.
 */
export function claudeProviderOptionLabel(authMethod: string | undefined): string {
  switch (authMethod) {
    case 'api-key':
      return 'Claude (uses an API key)';
    case 'gateway':
      return 'Claude (via a gateway)';
    case 'cli':
      return 'Claude (via Claude Code CLI)';
    case 'subscription':
    default:
      return 'Claude (uses your Claude account)';
  }
}

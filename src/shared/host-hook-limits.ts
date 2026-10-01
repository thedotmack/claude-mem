import { HOOK_TIMEOUTS, getTimeout, hookProcessOverheadMs } from './hook-constants.js';

/**
 * The per-hook timeout the Antigravity CLI installer registers for every
 * claude-mem hook (AntigravityCliHooksInstaller reads it from here).
 */
export const ANTIGRAVITY_HOOK_TIMEOUT_MS = 10_000;

/**
 * How long each host lets the SessionStart context hook run before it kills
 * the hook and drops its output, keyed by the platform id the hook command
 * passes (`hook <platform> context`). One place per host:
 * - claude-code: the SessionStart context hook `timeout` in plugin/hooks/hooks.json;
 * - codex: the SessionStart `timeout` in plugin/hooks/codex-hooks.json;
 * - antigravity(-cli): the installer's per-hook timeout above.
 * tests/shared/host-hook-limits.test.ts fails when a registration drifts.
 */
export const SESSION_START_HOOK_LIMIT_MS: Readonly<Record<string, number>> = Object.freeze({
  'claude-code': 60_000,
  codex: 20_000,
  'antigravity-cli': ANTIGRAVITY_HOOK_TIMEOUT_MS,
  antigravity: ANTIGRAVITY_HOOK_TIMEOUT_MS,
});

/**
 * The request budget for the server-runtime SessionStart read (POST
 * /v1/context): what the host's SessionStart limit leaves after the hook's own
 * overhead (hookProcessOverheadMs, the same allowance the UserPromptSubmit
 * budget uses), and never more than the client's default request timeout. A
 * host that registers no limit keeps that default.
 */
export function serverSessionStartBudgetMs(host: string | undefined): number {
  const clientDefaultMs = getTimeout(HOOK_TIMEOUTS.API_REQUEST);
  if (host === undefined || !Object.hasOwn(SESSION_START_HOOK_LIMIT_MS, host)) return clientDefaultMs;
  const limitMs = SESSION_START_HOOK_LIMIT_MS[host];
  return Math.max(1_000, Math.min(clientDefaultMs, limitMs - hookProcessOverheadMs()));
}

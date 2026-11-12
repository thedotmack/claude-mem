import { HOOK_TIMEOUTS, getTimeout, hookProcessOverheadMs } from './hook-constants.js';

/**
 * The per-hook timeout the Antigravity CLI installer registers for every
 * claude-mem hook. AntigravityCliHooksInstaller writes it to hooks.json in
 * seconds, the unit agy reads (#4196); 30 s is agy's own default.
 */
export const ANTIGRAVITY_HOOK_TIMEOUT_MS = 30_000;

/**
 * The per-hook timeout the Gemini CLI installer registers for every claude-mem
 * hook in ~/.gemini/settings.json (milliseconds, the unit Gemini CLI reads).
 * 60 s is Gemini CLI's own documented default (docs/hooks/reference.md,
 * "Execution timeout in milliseconds (default: 60000)"), so registering it
 * explicitly changes nothing about when Gemini kills a hook; it only gives the
 * server-runtime SessionStart read a known budget.
 */
export const GEMINI_HOOK_TIMEOUT_MS = 60_000;

/**
 * How long each host lets the SessionStart context hook run before it kills
 * the hook and drops its output, keyed by the platform id the hook command
 * passes (`hook <platform> context`). One place per host:
 * - claude-code: the SessionStart context hook `timeout` in plugin/hooks/hooks.json;
 * - codex: the SessionStart `timeout` in plugin/hooks/codex-hooks.json;
 * - antigravity(-cli): the installer's per-hook timeout above;
 * - gemini: the Gemini CLI installer's per-hook timeout above.
 * tests/shared/host-hook-limits.test.ts fails when a registration drifts.
 */
export const SESSION_START_HOOK_LIMIT_MS: Readonly<Record<string, number>> = Object.freeze({
  'claude-code': 60_000,
  codex: 20_000,
  'antigravity-cli': ANTIGRAVITY_HOOK_TIMEOUT_MS,
  antigravity: ANTIGRAVITY_HOOK_TIMEOUT_MS,
  gemini: GEMINI_HOOK_TIMEOUT_MS,
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

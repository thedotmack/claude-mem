// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - systemMessage                        → USER_HINT (user-visible; via stdout JSON systemMessage)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
// logger.* calls are DIAGNOSTIC and route through hook-io's stderr path.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  getWorkerPort,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { proTrialLine, proTrialUrl, PLAN_USAGE_GAIN_PERCENT } from '../../shared/pro-promo.js';
import {
  hasShownProFallbackNotice,
  isCmemGatewayUrl,
  markProFallbackNoticeShown,
  trialDaysRemaining,
} from '../../shared/cmem-gateway.js';
import { readSigninState, reminderShownForSession } from '../../npx-cli/install/signin-state.js';
import { armShowsReminder } from '../../npx-cli/install/signin-arm.js';
import { formatSigninReminder } from '../../services/signin-reminder.js';

/**
 * Sign-in reminder for an unclaimed agent-run install (arm C). The local
 * state check runs first so every other install makes no extra worker call;
 * the worker then polls the old pairing and mints a fresh link (3s budget).
 * Any failure means no reminder.
 */
async function fetchSigninReminder(sessionId: string): Promise<{ systemMessage: string; additionalContext: string } | null> {
  const state = readSigninState();
  if (!sessionId || state?.state !== 'unclaimed' || !state.arm || !armShowsReminder(state.arm)) return null;
  if (reminderShownForSession(sessionId)) return null;
  const result = await executeWithWorkerFallback<{ show?: boolean; url?: unknown; expires_in?: unknown }>(
    `/api/signin/reminder?session_id=${encodeURIComponent(sessionId)}`,
    'GET',
    undefined,
    { timeoutMs: 4_000 },
  );
  if (isWorkerFallback(result) || !result || result.show !== true) return null;
  if (typeof result.url !== 'string' || !result.url.startsWith('https://')) return null;
  const expiresIn = typeof result.expires_in === 'number' ? result.expires_in : 1800;
  return formatSigninReminder(result.url, expiresIn);
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();

    // Honor CLAUDE_MEM_EXCLUDED_PROJECTS on the inject/read path too. The
    // write path (ingestObservation) already skips excluded projects, but the
    // SessionStart summary was injected regardless — so an excluded dir (e.g.
    // "~") still got a context dump on every new session. Suppress it here.
    if (!shouldTrackProject(cwd)) {
      return {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        exitCode: HOOK_EXIT_CODES.SUCCESS,
      };
    }

    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    const settings = loadFromFileOnce();
    // Codex already receives the timeline through additionalContext. Repeating
    // it as systemMessage can push SessionStart stdout past Codex's hook-output
    // limit, causing Codex to discard the entire payload (including context).
    const showTerminalOutput =
      settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true'
      && input.platform !== 'codex';

    const projectsParam = context.allProjects.join(',');
    const normalizedPlatformSource = input.platform
      ? normalizePlatformSource(input.platform)
      : undefined;
    const platformSourceParam = input.platform
      ? `&platformSource=${encodeURIComponent(normalizedPlatformSource!)}`
      : '';
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}${platformSourceParam}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    // ponytail: Codex's MCP normally starts the worker; this one bounded
    // fallback covers cold sessions without the old startup process chain.
    const workerOptions = input.platform === 'codex'
      ? { workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT, timeoutMs: 2_000 }
      : undefined;
    const contextResult = await executeWithWorkerFallback<string>(apiPath, 'GET', undefined, workerOptions);
    if (isWorkerFallback(contextResult)) {
      return emptyResult;
    }

    let additionalContext: string;
    if (typeof contextResult === 'string') {
      additionalContext = contextResult.trim();
    } else if (contextResult === undefined) {
      additionalContext = '';
    } else {
      logger.warn('HOOK', 'Context response was not a string', { type: typeof contextResult });
      return emptyResult;
    }

    // Issue #2215: surface stale OAuth token marker as a session-start hint.
    // Marker is written by EnvManager.buildIsolatedEnvWithFreshOAuth() when
    // a previous worker spawn detected an expired keychain entry.
    const staleReason = readStaleMarker();
    if (staleReason) {
      const hint = `[claude-mem] Claude Desktop OAuth token is stale: ${staleReason}\nPlease re-login via Claude Desktop to refresh the token.`;
      additionalContext = additionalContext
        ? `${hint}\n\n${additionalContext}`
        : hint;
    }

    // Trial-expiry fallback notice (plan 2026-08-26 Phase 6): the worker wrote
    // CLAUDE_MEM_PRO_FALLBACK_AT when the cmem gateway terminally rejected the
    // delivered key, and dispatch now runs memory on the Anthropic plan. Tell
    // the user exactly once (DATA_DIR marker file, oauth-stale pattern); the
    // marker resets whenever the fallback is cleared.
    const fallbackActive = settings.CLAUDE_MEM_PRO_FALLBACK_AT !== ''
      && settings.CLAUDE_MEM_PROVIDER === 'openrouter'
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
    if (fallbackActive && !hasShownProFallbackNotice()) {
      const fallbackNotice = 'Your claude-mem free trial ended — memory now runs on your Anthropic plan.\n'
        + `Keep it off-plan (up to ${PLAN_USAGE_GAIN_PERCENT}% more usage): ${proTrialUrl('fallback')}`;
      additionalContext = additionalContext
        ? `${fallbackNotice}\n\n${additionalContext}`
        : fallbackNotice;
      markProFallbackNoticeShown();
    }

    const signinReminder = await fetchSigninReminder(input.sessionId);
    if (signinReminder) {
      additionalContext = additionalContext
        ? `${signinReminder.additionalContext}\n\n${additionalContext}`
        : signinReminder.additionalContext;
    }

    let coloredTimeline = '';
    if (showTerminalOutput) {
      const colorResult = await executeWithWorkerFallback<string>(colorApiPath, 'GET', undefined, workerOptions);
      if (!isWorkerFallback(colorResult) && typeof colorResult === 'string') {
        coloredTimeline = colorResult.trim();
      }
    }

    const platform = input.platform;

    // Antigravity CLI (like the former Gemini CLI) is hooks-based, not an
    // MCP-context-fetch platform like Codex — colorApiPath never populates
    // coloredTimeline for it (colors are claude-code-only above), so fall
    // back to the plain additionalContext for terminal display.
    const displayContent = coloredTimeline || (platform === 'antigravity-cli' ? additionalContext : '');

    // Days-remaining nicety: while the free trial is active (plan 'trial', an
    // end date stored, no fallback), append the countdown. Computed locally —
    // no network — and display-only: nothing is enabled or disabled by it.
    const daysLeft = !fallbackActive && settings.CLAUDE_MEM_PRO_PLAN === 'trial'
      ? trialDaysRemaining(settings.CLAUDE_MEM_PRO_TRIAL_ENDS_AT)
      : null;
    const trialDaysLine = daysLeft !== null && daysLeft >= 0
      ? `claude-mem free trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
      : null;

    const timelineMessage = showTerminalOutput && displayContent
      ? `${displayContent}\n\nView Observations Live @ http://localhost:${port}\n${proTrialLine('session-start')}${trialDaysLine ? `\n${trialDaysLine}` : ''}`
      : undefined;
    const systemMessage = signinReminder
      ? (timelineMessage ? `${timelineMessage}\n${signinReminder.systemMessage}` : signinReminder.systemMessage)
      : timelineMessage;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      },
      systemMessage
    };
  }
};

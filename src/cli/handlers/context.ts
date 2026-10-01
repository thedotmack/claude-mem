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
  getViewerBaseUrl,
  consumeWorkerOutageNotice,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { proTrialLine } from '../../shared/pro-promo.js';
import {
  hasShownProFallbackNotice,
  isCmemGatewayUrl,
  markProFallbackNoticeShown,
  proFallbackNotice,
  trialDaysRemaining,
} from '../../shared/cmem-gateway.js';
import { resolveRuntimeContext, type ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import type { ContextInput } from '../../services/context/types.js';

// Plan-24 step 4 (#2991): in server runtime every write goes to the shared
// server, so SessionStart reads from it too, straight from this hook process.
// The rows go through the same renderer and 10,000-character budget as the
// worker's /api/context/inject (#4112). No local worker is started or asked,
// and a server that cannot answer yields an empty block (logged as
// [server-fallback]), never stale local rows. The colored terminal render is
// fetched concurrently, so a slow server costs one request timeout, not two.
async function renderSessionStartFromServer(
  runtime: ServerRuntimeContext,
  contextInput: ContextInput,
  withColoredTerminalRender: boolean,
  modeId: string,
): Promise<{ model: string; terminal: string }> {
  const [{ generateServerContextWithStats }, { ModeManager }] = await Promise.all([
    import('../../services/context/ContextBuilder.js'),
    import('../../services/domain/ModeManager.js'),
  ]);
  // The worker loads the active mode at boot. This hook process has no worker,
  // so it loads the same mode itself: the renderer reads its observation types,
  // emojis and legend.
  ModeManager.getInstance().loadMode(modeId);
  const [model, colored] = await Promise.all([
    generateServerContextWithStats(runtime, contextInput, false),
    withColoredTerminalRender ? generateServerContextWithStats(runtime, contextInput, true) : null,
  ]);
  return { model: model.text, terminal: colored ? colored.text : model.text };
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
    // Let users share startup memory across harnesses without changing the
    // source-scoped behavior of search and other context requests.
    const platformSourceParam = input.platform && settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES !== 'true'
      ? `&platformSource=${encodeURIComponent(normalizedPlatformSource!)}`
      : '';
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}${platformSourceParam}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    // Server runtime reads the shared server (plan-24 step 4). When the server
    // settings are incomplete, resolveRuntimeContext() falls back to the worker,
    // exactly as the write hooks do, so reads and writes stay on one corpus.
    const runtime = resolveRuntimeContext();
    const serverRuntime = runtime.runtime === 'server' ? runtime : null;
    const serverRender = serverRuntime
      ? await renderSessionStartFromServer(
          serverRuntime,
          {
            session_id: input.sessionId,
            cwd,
            projects: context.allProjects,
            ...(platformSourceParam ? { platformSource: normalizedPlatformSource } : {}),
          },
          showTerminalOutput && input.platform === 'claude-code',
          settings.CLAUDE_MEM_MODE,
        )
      : null;

    // ponytail: Codex's MCP normally starts the worker; this one bounded
    // fallback covers cold sessions without the old startup process chain.
    const workerOptions = input.platform === 'codex'
      ? { workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT, timeoutMs: 2_000 }
      : undefined;
    const contextResult = serverRender
      ? serverRender.model
      : await executeWithWorkerFallback<string>(apiPath, 'GET', undefined, workerOptions);
    if (isWorkerFallback(contextResult)) {
      // SessionStart context is synchronous, so a systemMessage here is shown
      // to the user: the once-per-session worker-outage notice, if any.
      const outageNotice = await consumeWorkerOutageNotice(input.sessionId);
      return outageNotice ? { ...emptyResult, systemMessage: outageNotice } : emptyResult;
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
      // The observer authenticates with the Claude Code CLI credentials
      // (keychain service "Claude Code-credentials", see oauth-token.ts), not
      // Claude Desktop. Point the remedy at the CLI so the user runs the right
      // login (#4150).
      const hint = `[claude-mem] Claude Code OAuth token is stale: ${staleReason}\nRun /login in Claude Code (or \`claude auth login\` in a terminal) to refresh it.`;
      additionalContext = additionalContext
        ? `${hint}\n\n${additionalContext}`
        : hint;
    }

    // Trial-expiry fallback notice (plan 2026-08-26 Phase 6): the worker wrote
    // CLAUDE_MEM_PRO_FALLBACK_AT when the cmem gateway terminally rejected the
    // delivered key, and dispatch now runs memory on the Anthropic plan. Tell
    // the user exactly once (DATA_DIR marker file, oauth-stale pattern); the
    // marker resets whenever the fallback is cleared.
    //
    // The gateway's own words, stored with the marker, say what happened and
    // what to do. They enter model context, so proFallbackNotice relays them
    // as plain bounded lines and keeps only an https cmem.ai link.
    const fallbackActive = settings.CLAUDE_MEM_PRO_FALLBACK_AT !== ''
      && settings.CLAUDE_MEM_PROVIDER === 'openrouter'
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
    if (fallbackActive && !hasShownProFallbackNotice()) {
      const fallbackNotice = proFallbackNotice({
        message: settings.CLAUDE_MEM_PRO_FALLBACK_MESSAGE,
        action: settings.CLAUDE_MEM_PRO_FALLBACK_ACTION,
        url: settings.CLAUDE_MEM_PRO_FALLBACK_URL,
      });
      additionalContext = additionalContext
        ? `${fallbackNotice}\n\n${additionalContext}`
        : fallbackNotice;
      markProFallbackNoticeShown();
    }

    let coloredTimeline = '';
    if (showTerminalOutput) {
      const colorResult = serverRender
        ? serverRender.terminal
        : await executeWithWorkerFallback<string>(colorApiPath, 'GET', undefined, workerOptions);
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

    // In server runtime the viewer is served by the server (#2552), not by a
    // local worker, so the link points there.
    const viewerUrl = serverRuntime ? serverRuntime.serverBaseUrl : getViewerBaseUrl(port);
    const systemMessage = showTerminalOutput && displayContent
      ? `${displayContent}\n\nView Observations Live @ ${viewerUrl}\n${proTrialLine('session-start')}${trialDaysLine ? `\n${trialDaysLine}` : ''}`
      : undefined;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      },
      systemMessage
    };
  }
};

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
  cmemGatewayRole,
  hasShownProFallbackNotice,
  markProFallbackNoticeShown,
  proFallbackNotice,
  trialDaysRemaining,
} from '../../shared/cmem-gateway.js';
import { resolveRuntimeContext, type ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import type { ContextInput } from '../../services/context/types.js';
import { serverSessionStartBudgetMs } from '../../shared/host-hook-limits.js';
import { contextCacheKeys, fillContextPlaceholders, readContextCache } from '../../shared/context-cache.js';

// Plan-24 step 4 (#2991): in server runtime every write goes to the shared
// server, so SessionStart reads from it too, straight from this hook process.
// The rows go through the same renderer and 10,000-character budget as the
// worker's /api/context/inject (#4112). No local worker is started or asked,
// and a server that cannot answer yields an empty block (logged as
// [server-fallback]), never stale local rows. One read serves both the model
// block and the colored terminal copy, and it is bounded by what the host's
// SessionStart limit leaves (Codex kills the hook at 20 s, the client's own
// default is 30 s).
async function renderSessionStartFromServer(
  runtime: ServerRuntimeContext,
  contextInput: ContextInput,
  withColoredTerminalRender: boolean,
  modeId: string,
  host: string | undefined,
): Promise<{ model: string; terminal: string }> {
  const [{ generateServerSessionStartContext }, { ModeManager }] = await Promise.all([
    import('../../services/context/ContextBuilder.js'),
    import('../../services/domain/ModeManager.js'),
  ]);
  // The worker loads the active mode at boot. This hook process has no worker,
  // so it loads the same mode itself: the renderer reads its observation types,
  // emojis and legend.
  ModeManager.getInstance().loadMode(modeId);
  const { model, terminal } = await generateServerSessionStartContext(runtime, contextInput, {
    withTerminalRender: withColoredTerminalRender,
    timeoutMs: serverSessionStartBudgetMs(host),
  });
  return { model, terminal: terminal ?? model };
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    // --continue, --resume and /resume restore the existing conversation.
    // A fresh timeline would change its prompt prefix and invalidate the cache.
    // Also guard direct calls from older hook registrations that include resume.
    if (input.platform === 'claude-code' && input.sessionSource === 'resume') {
      return emptyResult;
    }

    const cwd = input.cwd ?? process.cwd();

    // Honor CLAUDE_MEM_EXCLUDED_PROJECTS on the inject/read path too. The
    // write path (ingestObservation) already skips excluded projects, but the
    // SessionStart summary was injected regardless — so an excluded dir (e.g.
    // "~") still got a context dump on every new session. Suppress it here.
    if (!shouldTrackProject(cwd)) {
      return emptyResult;
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
          input.platform,
        )
      : null;

    // Precomputed SessionStart context (liveness plan, Phase 6): the worker
    // keeps each variant it has served rendered on disk, keyed exactly like
    // the URLs above. A hit needs no worker at all; a miss takes the live path.
    const cacheNowEpochMs = Date.now();
    const readCachedRender = (colors: boolean): string | null => {
      if (serverRuntime) return null;
      const keys = contextCacheKeys(context.allProjects, platformSourceParam ? normalizedPlatformSource : undefined, colors);
      const cached = readContextCache(keys, cacheNowEpochMs);
      if (!cached) return null;
      logger.debug('HOOK', 'SessionStart context served from the context cache', {
        colors,
        renderedAgoMs: cacheNowEpochMs - cached.renderedAtEpochMs,
      });
      return fillContextPlaceholders(cached.body, cacheNowEpochMs, cached.placeholderNonce);
    };
    const cachedModelContext = readCachedRender(false);

    // ponytail: Codex's MCP normally starts the worker; this one bounded
    // fallback covers cold sessions without the old startup process chain.
    const workerOptions = input.platform === 'codex'
      ? { workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT, timeoutMs: 2_000 }
      : undefined;
    const contextResult = serverRender
      ? serverRender.model
      : cachedModelContext ?? await executeWithWorkerFallback<string>(apiPath, 'GET', undefined, workerOptions);
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
    // Other observer providers do not use Claude credentials. Keep the hint
    // for a configured Claude route, including the gateway's active fallback.
    const gatewayRole = cmemGatewayRole(settings);
    const usesClaudeCredentials = (settings.CLAUDE_MEM_PROVIDER || 'claude') === 'claude'
      || String(settings.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER ?? '').trim() === 'claude'
      || (gatewayRole === 'primary' && Boolean(settings.CLAUDE_MEM_PRO_FALLBACK_AT));
    const staleReason = usesClaudeCredentials ? readStaleMarker() : null;
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
    //
    // The gateway as the opt-in quota fallback gets the same notice with its
    // own consequence: dispatch skips it while it turns the account away, and
    // without this the user would never learn why the fallback stopped.
    const fallbackActive = settings.CLAUDE_MEM_PRO_FALLBACK_AT !== '' && gatewayRole !== null;
    if (fallbackActive && !hasShownProFallbackNotice()) {
      const fallbackNotice = proFallbackNotice({
        message: settings.CLAUDE_MEM_PRO_FALLBACK_MESSAGE,
        action: settings.CLAUDE_MEM_PRO_FALLBACK_ACTION,
        url: settings.CLAUDE_MEM_PRO_FALLBACK_URL,
      }, gatewayRole);
      additionalContext = additionalContext
        ? `${fallbackNotice}\n\n${additionalContext}`
        : fallbackNotice;
      markProFallbackNoticeShown();
    }

    let coloredTimeline = '';
    if (showTerminalOutput) {
      const colorResult = serverRender
        ? serverRender.terminal
        : readCachedRender(input.platform === 'claude-code')
          ?? await executeWithWorkerFallback<string>(colorApiPath, 'GET', undefined, workerOptions);
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

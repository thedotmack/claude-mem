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
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { callMcpToolOnce } from '../../shared/mcp-client.js';
import { selectRuntime, buildServerContext } from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';

async function requestSessionStartContext(args: {
  projects: string[];
  platformSource?: string;
  colors?: boolean;
}): Promise<string | null> {
  const result = await callMcpToolOnce('session_start_context', {
    projects: args.projects,
    ...(args.platformSource ? { platformSource: args.platformSource } : {}),
    ...(args.colors !== undefined ? { colors: args.colors } : {}),
  });
  if (result.isError) {
    logger.warn('HOOK', 'MCP session_start_context returned an error; falling back to worker HTTP', {
      preview: result.text.slice(0, 200),
    });
    return null;
  }
  return result.text.trim();
}

async function fetchSessionStartContextViaMcp(args: {
  projects: string[];
  platformSource?: string;
  colors?: boolean;
}): Promise<string | null> {
  try {
    return await requestSessionStartContext(args);
  } catch (error: unknown) {
    logger.warn('HOOK', 'MCP session_start_context failed; falling back to worker HTTP', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// CLAUDE_MEM_RUNTIME=server support (plans/2026-07-13-session-start-context-
// injection-server-mode.md / #2991). A server-runtime deployment typically
// has no worker running at all, so `executeWithWorkerFallback` below would
// always hit the worker-unreachable fallback and silently inject empty
// context on every session. This talks to the server runtime directly via
// `/v1/context` (query-less recency mode) instead. Returns null on any
// failure (missing config, transport error, etc.) so the caller degrades to
// `emptyResult` — deliberately NOT falling through to the worker path below,
// since a server-runtime deployment has no worker to fall back to.
//
// `limit` mirrors worker-mode's own CLAUDE_MEM_CONTEXT_OBSERVATIONS (default
// 50, see SettingsDefaultsManager) — the /v1/context route's own bare
// default (10) is tuned for its other caller (query-based search results),
// not "how much recent context should a fresh session start with", so an
// explicit limit here is required for parity, not optional.
async function fetchSessionStartContextViaServer(
  ctx: NonNullable<ReturnType<typeof buildServerContext>>,
  limit: number,
): Promise<string | null> {
  try {
    const { context } = await ctx.client.contextObservations({ projectId: ctx.projectId, limit });
    return (context ?? '').trim();
  } catch (error: unknown) {
    if (isServerClientError(error)) {
      logger.warn('HOOK', `[server-context] ${error.kind}: ${error.message}`);
    } else {
      logger.warn('HOOK', 'Server context fetch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    const settings = loadFromFileOnce();
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

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

    let additionalContext: string;
    // Tracks whether additionalContext came from the server-runtime branch,
    // so the coloredTimeline block below (showTerminalOutput) also skips its
    // own independent worker round-trip instead of lazy-spawning a local
    // worker as a side effect — see plans/2026-07-13-session-start-context-
    // injection-server-mode.md. showTerminalOutput defaults to 'true'
    // (SettingsDefaultsManager), so this isn't a rare edge case: without this
    // guard, every SessionStart hook in a server-runtime deployment would
    // still attempt to spawn a local worker it has no business running.
    let usedServerRuntime = false;
    // Resolved once regardless of platform: Codex's own MCP-based context
    // fetch (below) is worker-backed and has no server-runtime awareness of
    // its own, so a server-runtime deployment needs this same fallback for
    // Codex too, not just Claude Code — see the `mcpContextResult === null`
    // branch below.
    const isServerRuntime = selectRuntime() === 'server';
    const serverRuntimeCtx = isServerRuntime ? buildServerContext() : null;
    const contextObservationLimit = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10) || 50;
    const mcpContextResult = input.platform === 'codex'
      ? await fetchSessionStartContextViaMcp({
          projects: context.allProjects,
          ...(normalizedPlatformSource ? { platformSource: normalizedPlatformSource } : {}),
        })
      : null;

    if (mcpContextResult !== null) {
      additionalContext = mcpContextResult;
    } else if (isServerRuntime) {
      // A server-runtime deployment has no worker to fall back to — even
      // when misconfigured (serverRuntimeCtx null), degrade straight to
      // emptyResult rather than falling through to the worker branch below.
      if (!serverRuntimeCtx) {
        return emptyResult;
      }
      const serverContext = await fetchSessionStartContextViaServer(serverRuntimeCtx, contextObservationLimit);
      if (serverContext === null) {
        return emptyResult;
      }
      additionalContext = serverContext;
      usedServerRuntime = true;
    } else {
      const contextResult = await executeWithWorkerFallback<string>(apiPath, 'GET');
      if (isWorkerFallback(contextResult)) {
        return emptyResult;
      }

      if (typeof contextResult === 'string') {
        additionalContext = contextResult.trim();
      } else if (contextResult === undefined) {
        additionalContext = '';
      } else {
        logger.warn('HOOK', 'Context response was not a string', { type: typeof contextResult });
        return emptyResult;
      }
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

    let coloredTimeline = '';
    if (showTerminalOutput) {
      if (usedServerRuntime) {
        // No server-side "colors" variant of /v1/context (colors are a
        // worker-HTTP-only query param, cosmetic ANSI codes for interactive
        // terminal display) — reuse the already-fetched plain
        // additionalContext rather than attempting a worker round-trip that
        // has no worker to reach in a server-runtime deployment.
        coloredTimeline = additionalContext;
      } else {
        const mcpColorResult = input.platform === 'codex'
          ? await fetchSessionStartContextViaMcp({
              projects: context.allProjects,
              ...(normalizedPlatformSource ? { platformSource: normalizedPlatformSource } : {}),
              colors: true,
            })
          : null;
        if (mcpColorResult !== null) {
          coloredTimeline = mcpColorResult;
        } else {
          const colorResult = await executeWithWorkerFallback<string>(colorApiPath, 'GET');
          if (!isWorkerFallback(colorResult) && typeof colorResult === 'string') {
            coloredTimeline = colorResult.trim();
          }
        }
      }
    }

    const platform = input.platform;

    // Antigravity CLI (like the former Gemini CLI) is hooks-based, not an
    // MCP-context-fetch platform like Codex — colorApiPath never populates
    // coloredTimeline for it (colors are claude-code-only above), so fall
    // back to the plain additionalContext for terminal display.
    const displayContent = coloredTimeline || (platform === 'antigravity-cli' ? additionalContext : '');

    // In server runtime the viewer isn't a local worker on this machine —
    // localhost:${port} would be unreachable (or point at an unrelated
    // local service) once CLAUDE_MEM_SERVER_URL is remote or on another
    // port. Point at the actual server instead.
    const viewerUrl = usedServerRuntime && serverRuntimeCtx
      ? serverRuntimeCtx.serverBaseUrl
      : `http://localhost:${port}`;
    const systemMessage = showTerminalOutput && displayContent
      ? `${displayContent}\n\nView Observations Live @ ${viewerUrl}`
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

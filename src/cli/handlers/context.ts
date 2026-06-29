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

async function fetchSessionStartContextViaMcp(args: {
  projects: string[];
  platformSource?: string;
  colors?: boolean;
}): Promise<string | null> {
  try {
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
  } catch (error: unknown) {
    logger.warn('HOOK', 'MCP session_start_context failed; falling back to worker HTTP', {
      error: error instanceof Error ? error.message : String(error),
    });
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
    const mcpContextResult = input.platform === 'codex'
      ? await fetchSessionStartContextViaMcp({
          projects: context.allProjects,
          ...(normalizedPlatformSource ? { platformSource: normalizedPlatformSource } : {}),
        })
      : null;

    if (mcpContextResult !== null) {
      additionalContext = mcpContextResult;
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

    const platform = input.platform;

    const displayContent = coloredTimeline || (platform === 'gemini-cli' || platform === 'gemini' ? additionalContext : '');

    const systemMessage = showTerminalOutput && displayContent
      ? `${displayContent}\n\nView Observations Live @ http://localhost:${port}`
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

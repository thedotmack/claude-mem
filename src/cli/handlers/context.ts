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

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    const settings = loadFromFileOnce();
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    const projectsParam = context.allProjects.join(',');
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    const contextResult = await executeWithWorkerFallback<string>(apiPath, 'GET');
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

    const platform = input.platform;
    const isCodex = platform === 'codex';

    let systemMessage: string | undefined;
    if (showTerminalOutput) {
      if (isCodex) {
        // Codex's TUI flattens newlines when it surfaces hook output AND already
        // echoes additionalContext back as its own "hook context" block. Re-sending
        // the full timeline through systemMessage just duplicates that wall of text
        // (shown as a "warning:" block) into an unreadable single line. Surface a
        // compact one-line summary that stays legible even after Codex flattens it;
        // the model still receives the full, properly formatted additionalContext.
        if (additionalContext) {
          const statsLine = additionalContext.match(/^Stats:\s*(.+)$/m)?.[1]?.trim();
          const summary = statsLine
            ? `📋 claude-mem: ${statsLine}`
            : '📋 claude-mem: recent context loaded';
          systemMessage = `${summary} · http://localhost:${port}`;
        }
      } else {
        const colorResult = await executeWithWorkerFallback<string>(colorApiPath, 'GET');
        const coloredTimeline =
          !isWorkerFallback(colorResult) && typeof colorResult === 'string'
            ? colorResult.trim()
            : '';
        const displayContent =
          coloredTimeline ||
          (platform === 'gemini-cli' || platform === 'gemini' ? additionalContext : '');
        systemMessage = displayContent
          ? `${displayContent}\n\nView Observations Live @ http://localhost:${port}`
          : undefined;
      }
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      },
      systemMessage
    };
  }
};

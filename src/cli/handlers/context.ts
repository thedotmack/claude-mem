// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - systemMessage                        → USER_HINT (user-visible; via stdout JSON systemMessage)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
// logger.* calls are DIAGNOSTIC and route through hook-io's stderr path.
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  getWorkerPort,
  type WorkerCallResult,
} from '../../shared/worker-utils.js';
import type { BottleRenderResult } from '../../services/worker/BottleRenderer.js';
import { BOTTLES_DIR, BOTTLES_ARCHIVE_DIR, ensureDir } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { callMcpToolOnce } from '../../shared/mcp-client.js';

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

// Spec §7 (plans/2026-07-17-endless-mode-v1.md): full-mode bullets. The
// "Do not repeat" line is load-bearing — without it, models reliably re-send
// their final message or redo finished work.
const FULL_MODE_BULLETS = `- It is the authoritative session record: verbatim conversation, with
  observations in place of tool activity. Where it conflicts with the
  summary above, the bottle wins.
- The final assistant message in it was already delivered to the user.
  Do not repeat it or redo work it describes as done — continue from its
  end state.`;

// Spec §7: degraded mode swaps the middle bullets.
const DEGRADED_MODE_BULLETS = `- It is a partial reconstruction: only the user's messages are verbatim.
  Your own replies were not preserved — do not assume prior phrasings.
  Session summary blocks are generated, not your words.
- The last session summary describes where you left off; continue from there.`;

function buildBottlePointer(r: Partial<BottleRenderResult>): string {
  const bullets = r.mode === 'reconstructed' ? DEGRADED_MODE_BULLETS : FULL_MODE_BULLETS;
  // Spec §7 says one line; enforce hook-side rather than trusting the worker
  // version-skew.
  const currentTask = String(r.currentTask ?? '').split('\n')[0]?.slice(0, 300) ?? '';
  return `# [claude-mem] Endless Mode — session continuation

Before doing anything else, Read this file and continue the session from
where it ends:

    ${r.bottlePath ?? ''}

${bullets}
- The newest tool activity may still be settling into observations;
  check the timeline if the last few minutes look thin.

Current task: ${currentTask}`;
}

// Issue #2215: surface stale OAuth token marker as a session-start hint.
// Marker is written by EnvManager.buildIsolatedEnvWithFreshOAuth() when
// a previous worker spawn detected an expired keychain entry.
function withStaleTokenHint(additionalContext: string): string {
  const staleReason = readStaleMarker();
  if (!staleReason) return additionalContext;
  const hint = `[claude-mem] Claude Desktop OAuth token is stale: ${staleReason}\nPlease re-login via Claude Desktop to refresh the token.`;
  return additionalContext ? `${hint}\n\n${additionalContext}` : hint;
}

// Same safe-id shape as BottleRenderer: the id becomes a filename.
const SAFE_SESSION_ID_REGEX = /^[A-Za-z0-9._-]+$/;

function isSafeSessionIdForPath(id: unknown): id is string {
  return typeof id === 'string'
    && SAFE_SESSION_ID_REGEX.test(id)
    && id !== '.'
    && id !== '..';
}

// /clear means the user asked to forget: move the bottle aside. Hook-side
// (pure DATA_DIR rename) so it works when the worker is down.
function archiveBottleOnClear(sessionId: unknown): void {
  if (!isSafeSessionIdForPath(sessionId)) return;
  const bottlePath = join(BOTTLES_DIR, `${sessionId}.md`);
  try {
    if (!existsSync(bottlePath)) return;
    ensureDir(BOTTLES_ARCHIVE_DIR);
    renameSync(bottlePath, join(BOTTLES_ARCHIVE_DIR, `${Date.now()}-${sessionId}.md`));
  } catch (error: unknown) {
    logger.warn('HOOK', 'Failed to archive bottle on clear', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    const settings = loadFromFileOnce();
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    if (input.platform === 'claude-code' && input.sessionSource === 'clear') {
      // Archive only; existing clear behavior (timeline injection) continues below.
      archiveBottleOnClear(input.sessionId);
    }

    if (
      input.platform === 'claude-code' &&
      (input.sessionSource === 'compact' || input.sessionSource === 'resume')
    ) {
      if (settings.CLAUDE_MEM_ENDLESS_MODE_ENABLED !== 'false') {
        let render: WorkerCallResult<Partial<BottleRenderResult>> | undefined;
        try {
          render = await executeWithWorkerFallback<Partial<BottleRenderResult>>(
            '/api/sessions/render-bottle',
            'POST',
            {
              contentSessionId: input.sessionId,
              transcript_path: input.transcriptPath,
              cwd,
              wait: true,
            },
            { timeoutMs: 10000 },
          );
        } catch (error: unknown) {
          // fetch timeouts THROW (executeWithWorkerFallback only brands 429/5xx);
          // an escaped throw would skip the fallback below and hit the hook's
          // error path — treat it as "failure → fall through".
          logger.warn('HOOK', 'render-bottle call failed; falling back', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (render !== undefined && !isWorkerFallback(render) && typeof render === 'object'
            && render !== null && typeof render.bottlePath === 'string' && render.bottlePath) {
          return {
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: withStaleTokenHint(buildBottlePointer(render)),
            },
          };
        }
      }
      // Failure floor. Resume sessions got NO SessionStart injection before
      // Endless Mode (resume was not in the hook matcher), so a resume whose
      // render fails — or with the feature disabled — keeps that behavior
      // rather than gaining a brand-new timeline injection.
      if (input.sessionSource === 'resume') {
        return emptyResult;
      }
      // compact: any failure (fallback, disabled, nothing_to_render, throw)
      // falls through to the existing timeline path unchanged.
    }

    const projectsParam = context.allProjects.join(',');
    const normalizedPlatformSource = input.platform
      ? normalizePlatformSource(input.platform)
      : undefined;
    const platformSourceParam = input.platform
      ? `&platformSource=${encodeURIComponent(normalizedPlatformSource!)}`
      : '';
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}${platformSourceParam}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

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

    additionalContext = withStaleTokenHint(additionalContext);

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

    // Antigravity CLI (like the former Gemini CLI) is hooks-based, not an
    // MCP-context-fetch platform like Codex — colorApiPath never populates
    // coloredTimeline for it (colors are claude-code-only above), so fall
    // back to the plain additionalContext for terminal display.
    const displayContent = coloredTimeline || (platform === 'antigravity-cli' ? additionalContext : '');

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

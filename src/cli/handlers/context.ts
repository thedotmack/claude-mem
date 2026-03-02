/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code to inject.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { getProjectContext, loadHubConfig } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

interface HubProjectStat {
  project: string;
  observation_count: number;
  last_active_epoch: number;
}

/**
 * Fetch hub project stats and format as a markdown table.
 * Returns null if the fetch fails (non-blocking).
 */
async function fetchHubProjectsTable(
  port: number,
  hubConfig: { project_patterns: Record<string, string> }
): Promise<string | null> {
  try {
    const allProjects = [...new Set(Object.values(hubConfig.project_patterns))];
    const url = `http://127.0.0.1:${port}/api/hub/projects?projects=${encodeURIComponent(allProjects.join(','))}`;
    const response = await fetch(url);

    if (!response.ok) return null;

    const stats: HubProjectStat[] = await response.json() as HubProjectStat[];

    if (stats.length === 0) return null;

    const now = Date.now();
    const lines: string[] = [];
    lines.push('## Hub Projects (recent activity)');
    lines.push('| Project | Last Active | Observations |');
    lines.push('|---------|-------------|--------------|');

    for (const stat of stats) {
      const ago = formatTimeAgo(now, stat.last_active_epoch);
      lines.push(`| ${stat.project} | ${ago} | ${stat.observation_count} |`);
    }

    lines.push('');
    lines.push('Use `/focus <project>` to load a project\'s context.');

    return lines.join('\n');
  } catch (error) {
    logger.warn('HOOK', 'Hub projects fetch failed (non-blocking)', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Format epoch timestamp as relative time (e.g., "2h ago", "3d ago")
 */
function formatTimeAgo(nowMs: number, epochMs: number): string {
  const diffMs = nowMs - epochMs;
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - return empty context gracefully
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ''
        },
        exitCode: HOOK_EXIT_CODES.SUCCESS
      };
    }

    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    // Check if terminal output should be shown (load settings early)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    // Pass all projects (parent + worktree if applicable) for unified timeline
    const projectsParam = context.allProjects.join(',');
    const url = `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;

    // Note: Removed AbortSignal.timeout due to Windows Bun cleanup issue (libuv assertion)
    // Worker service has its own timeouts, so client-side timeout is redundant
    try {
      // Fetch markdown (for Claude context) and optionally colored (for user display)
      const colorUrl = `${url}&colors=true`;
      const [response, colorResponse] = await Promise.all([
        fetch(url),
        showTerminalOutput ? fetch(colorUrl).catch(() => null) : Promise.resolve(null)
      ]);

      if (!response.ok) {
        // Log but don't throw — context fetch failure should not block session start
        logger.warn('HOOK', 'Context generation failed, returning empty', { status: response.status });
        return {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
          exitCode: HOOK_EXIT_CODES.SUCCESS
        };
      }

      const [contextResult, colorResult] = await Promise.all([
        response.text(),
        colorResponse?.ok ? colorResponse.text() : Promise.resolve('')
      ]);

      let additionalContext = contextResult.trim();
      const coloredTimeline = colorResult.trim();

      // In hub mode, append a summary of active projects so the user can /focus
      const hubConfig = loadHubConfig(cwd);
      if (hubConfig) {
        const hubProjectsTable = await fetchHubProjectsTable(port, hubConfig);
        if (hubProjectsTable) {
          additionalContext = additionalContext
            ? `${additionalContext}\n\n${hubProjectsTable}`
            : hubProjectsTable;
        }
      }

      const systemMessage = showTerminalOutput && coloredTimeline
        ? `${coloredTimeline}\n\nView Observations Live @ http://localhost:${port}`
        : undefined;

      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext
        },
        systemMessage
      };
    } catch (error) {
      // Worker unreachable — return empty context gracefully
      logger.warn('HOOK', 'Context fetch error, returning empty', { error: error instanceof Error ? error.message : String(error) });
      return {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        exitCode: HOOK_EXIT_CODES.SUCCESS
      };
    }
  }
};

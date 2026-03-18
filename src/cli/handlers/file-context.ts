/**
 * File Context Handler - PreToolUse
 *
 * Injects relevant observation history when Claude reads/edits a file,
 * so it can avoid duplicating past work.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import path from 'path';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';

const TYPE_ICONS: Record<string, string> = {
  decision: '\u2696\uFE0F',
  bugfix: '\uD83D\uDD34',
  feature: '\uD83D\uDFE3',
  refactor: '\uD83D\uDD04',
  discovery: '\uD83D\uDD35',
  change: '\u2705',
};

function compactTime(timeStr: string): string {
  return timeStr.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

function formatTime(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface ObservationRow {
  id: number;
  title: string | null;
  type: string;
  created_at_epoch: number;
}

function formatFileTimeline(observations: ObservationRow[], filePath: string): string {
  // Group observations by day
  const byDay = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    const day = formatDate(obs.created_at_epoch);
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day)!.push(obs);
  }

  // Sort days chronologically
  const sortedDays = Array.from(byDay.entries()).sort((a, b) => {
    const aEpoch = a[1][0].created_at_epoch;
    const bEpoch = b[1][0].created_at_epoch;
    return aEpoch - bEpoch;
  });

  const lines: string[] = [
    `Existing observations for this file \u2014 review via get_observations([IDs]) to avoid duplicates:`,
  ];

  for (const [day, dayObservations] of sortedDays) {
    lines.push(`### ${day}`);
    for (const obs of dayObservations) {
      const title = obs.title || 'Untitled';
      const icon = TYPE_ICONS[obs.type] || '\u2753';
      const time = compactTime(formatTime(obs.created_at_epoch));
      lines.push(`${obs.id} ${time} ${icon} ${title}`);
    }
  }

  return lines.join('\n');
}

export const fileContextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Extract file_path from toolInput
    const toolInput = input.toolInput as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;

    if (!filePath) {
      return { continue: true, suppressOutput: true };
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (input.cwd && isProjectExcluded(input.cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file context', { cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    }

    // Ensure worker is running
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return { continue: true, suppressOutput: true };
    }

    // Query worker for observations related to this file
    try {
      const context = getProjectContext(input.cwd);
      // Observations store relative paths — convert absolute to relative using cwd
      const cwd = input.cwd || process.cwd();
      const relativePath = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
      const queryParams = new URLSearchParams({ path: relativePath });
      // Pass all project names (parent + worktree) for unified lookup
      queryParams.set('projects', context.allProjects.join(','));

      const response = await workerHttpRequest(`/api/observations/by-file?${queryParams.toString()}`, {
        method: 'GET',
      });

      if (!response.ok) {
        logger.warn('HOOK', 'File context query failed, skipping', { status: response.status, filePath });
        return { continue: true, suppressOutput: true };
      }

      const data = await response.json() as { observations: ObservationRow[]; count: number };

      if (!data.observations || data.observations.length === 0) {
        return { continue: true, suppressOutput: true };
      }

      const timeline = formatFileTimeline(data.observations, filePath);

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: timeline,
        },
      };
    } catch (error) {
      logger.warn('HOOK', 'File context fetch error, skipping', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { continue: true, suppressOutput: true };
    }
  },
};

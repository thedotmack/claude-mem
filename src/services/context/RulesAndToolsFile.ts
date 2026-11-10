import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ModeManager } from '../domain/ModeManager.js';
import { resolveDataDir } from '../../shared/data-dir.js';
import { writeTextFileAtomic } from '../../shared/atomic-json.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { isWorkStateEnabled } from '../../shared/work-state-setting.js';
import { mcpServerInstructions } from '../../shared/memory-instructions.js';
import { logger } from '../../utils/logger.js';

/**
 * How to read the startup timeline and use claude-mem's tools, kept in one file
 * instead of repeated at the top of every SessionStart message. The message
 * carries one line pointing here (rulesAndToolsPointerLine).
 */
export const RULES_AND_TOOLS_FILENAME = 'RULES-AND-TOOLS.md';

export function rulesAndToolsFilePath(): string {
  return join(resolveDataDir(), RULES_AND_TOOLS_FILENAME);
}

/** The path as the reader should type it: `~/…` under the home directory. */
export function rulesAndToolsDisplayPath(filePath: string = rulesAndToolsFilePath()): string {
  const home = homedir();
  return filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
}

export function rulesAndToolsPointerLine(): string {
  return `Access Claude-Mem Rules + Tools: ${rulesAndToolsDisplayPath()}`;
}

/**
 * The file's text for the active mode and runtime. Server runtime has no by-id
 * fetch (fetchByIdSupported false) and its own search tools.
 */
export function renderRulesAndToolsFile(fetchByIdSupported: boolean): string {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegend = mode.observation_types.map(t => `${t.emoji}${t.id}`).join(' ');
  const fetchLine = fetchByIdSupported
    ? 'Fetch details: get_observations([IDs]) | Search: mem-search skill'
    : 'Fetch details: observation_search by title (short refs are display-only)';
  const settings = loadFromFileOnce();
  const rules = mcpServerInstructions({
    runtime: fetchByIdSupported ? 'worker' : 'server',
    workStateEnabled: isWorkStateEnabled(settings.CLAUDE_MEM_WORK_STATE_ENABLED),
    memoryInstructionsEnabled: settings.CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED !== 'false',
  });
  return [
    '# Claude-Mem Rules + Tools',
    '',
    '## Reading the startup timeline',
    "The SessionStart message is this project's recent claude-mem timeline, grouped by day, oldest first; the newest entry is last.",
    'Format: ID TIME TYPE TITLE (a `"` time is the same as the row above)',
    `Legend: 🎯session ${typeLegend}`,
    `Mode: ${mode.name} (${ModeManager.getInstance().getActiveModeId()})`,
    fetchLine,
    ...(rules ? ['', rules] : []),
    '',
  ].join('\n');
}

/**
 * Write the file when its text changed. Called wherever the pointer line is
 * rendered, so the line never points at a missing or stale file. A failed write
 * is logged and the render goes on: the timeline is still worth delivering.
 */
export function ensureRulesAndToolsFile(fetchByIdSupported: boolean): void {
  const filePath = rulesAndToolsFilePath();
  try {
    const text = renderRulesAndToolsFile(fetchByIdSupported);
    if (existsSync(filePath) && readFileSync(filePath, 'utf-8') === text) return;
    writeTextFileAtomic(filePath, text);
  } catch (error) {
    logger.error('SYSTEM', 'Could not write the Rules + Tools file the startup message points to', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

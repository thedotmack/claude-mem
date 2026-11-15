import { existsSync, readFileSync } from 'fs';
import { ModeManager } from '../domain/ModeManager.js';
import { writeTextFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isWorkStateEnabled } from '../../shared/work-state-setting.js';
import { mcpServerInstructions } from '../../shared/memory-instructions.js';
import { homeRelativePath, rulesAndToolsFilePath } from '../../shared/claude-code-rules-import.js';
import { logger } from '../../utils/logger.js';

/**
 * How to read the startup timeline and use claude-mem's tools, kept in one file.
 * Claude Code loads it through MY-RULES.md when My Rules is loaded there
 * (shared/claude-code-rules-import.ts); otherwise the SessionStart message
 * carries one line pointing here (rulesAndToolsPointerLine).
 */
export {
  RULES_AND_TOOLS_FILENAME,
  rulesAndToolsFilePath,
  rulesAndToolsPointerLine,
} from '../../shared/claude-code-rules-import.js';

/** The path as the reader should type it: `~/…` under the home directory. */
export function rulesAndToolsDisplayPath(filePath: string = rulesAndToolsFilePath()): string {
  return homeRelativePath(filePath);
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
  // This renderer also lives in the persistent context-reader thread. A
  // hook-lifetime snapshot would keep disabled guidance until worker restart.
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
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
export function ensureRulesAndToolsFile(fetchByIdSupported: boolean, filePath: string = rulesAndToolsFilePath()): void {
  try {
    const text = renderRulesAndToolsFile(fetchByIdSupported);
    if (existsSync(filePath) && readFileSync(filePath, 'utf-8') === text) return;
    writeTextFileAtomic(filePath, text);
  } catch (error) {
    logger.error('SYSTEM', 'Could not write the Rules + Tools file the startup message points to', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

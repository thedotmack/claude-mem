import type { ContextConfig } from '../types.js';
import { colors } from '../types.js';
import { ensureRulesAndToolsFile, rulesAndToolsPointerLine } from '../RulesAndToolsFile.js';

/**
 * The one line above the timeline: where the rules for reading it and the
 * tools for using it live. The file is written (when changed) here, so the line
 * never points at a missing file.
 */
export function renderHeader(config: Pick<ContextConfig, 'fetchByIdSupported'>, forHuman: boolean): string[] {
  ensureRulesAndToolsFile(config.fetchByIdSupported !== false);
  const pointer = rulesAndToolsPointerLine();
  return [forHuman ? `${colors.dim}${pointer}${colors.reset}` : pointer, ''];
}

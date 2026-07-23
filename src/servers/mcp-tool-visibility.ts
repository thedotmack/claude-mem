import type { SelectedRuntime } from '../services/hooks/runtime-selector.js';
import { logger } from '../utils/logger.js';

export const SERVER_BETA_ONLY_TOOL_NAMES = [
  'observation_add',
  'observation_record_event',
  'observation_search',
  'observation_context',
  'observation_generation_status',
  'memory_add',
  'memory_search',
  'memory_context',
] as const;

const serverBetaOnlyToolNameSet = new Set<string>(SERVER_BETA_ONLY_TOOL_NAMES);

export function getAdvertisedMcpToolsForRuntime<T extends { name: string }>(
  allTools: readonly T[],
  runtime: SelectedRuntime
): T[] {
  if (runtime === 'server') {
    return [...allTools];
  }
  logger.debug('SYSTEM', 'Filtering server-beta-only MCP tools from worker runtime advertisement', {
    runtime,
    hiddenToolCount: SERVER_BETA_ONLY_TOOL_NAMES.length,
  });
  return allTools.filter((tool) => !serverBetaOnlyToolNameSet.has(tool.name));
}

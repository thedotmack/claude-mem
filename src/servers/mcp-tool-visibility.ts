import type { SelectedRuntime } from '../services/hooks/runtime-selector.js';
import { logger } from '../utils/logger.js';

export const SERVER_RUNTIME_ONLY_TOOL_NAMES = [
  'observation_add',
  'observation_record_event',
  'observation_search',
  'observation_context',
  'observation_generation_status',
] as const;

export const WORKER_RUNTIME_ONLY_TOOL_NAMES = [
  'memory_save',
] as const;

const serverRuntimeOnlyToolNameSet = new Set<string>(SERVER_RUNTIME_ONLY_TOOL_NAMES);
const workerRuntimeOnlyToolNameSet = new Set<string>(WORKER_RUNTIME_ONLY_TOOL_NAMES);

export function getAdvertisedMcpToolsForRuntime<T extends { name: string }>(
  allTools: readonly T[],
  runtime: SelectedRuntime,
): T[] {
  if (runtime === 'server') {
    logger.debug('SYSTEM', 'Filtering worker-only MCP tools from server runtime advertisement', {
      runtime,
      hiddenToolCount: WORKER_RUNTIME_ONLY_TOOL_NAMES.length,
    });
    return allTools.filter((tool) => !workerRuntimeOnlyToolNameSet.has(tool.name));
  }

  logger.debug('SYSTEM', 'Filtering server-runtime-only MCP tools from worker runtime advertisement', {
    runtime,
    hiddenToolCount: SERVER_RUNTIME_ONLY_TOOL_NAMES.length,
  });
  return allTools.filter((tool) => !serverRuntimeOnlyToolNameSet.has(tool.name));
}

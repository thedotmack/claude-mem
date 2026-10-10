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

export const WORK_STATE_TOOL_NAMES = ['work_state_write', 'work_state_read'] as const;

const workStateToolNameSet = new Set<string>(WORK_STATE_TOOL_NAMES);

/**
 * With CLAUDE_MEM_WORK_STATE_ENABLED=false the work_state_* tools are not
 * advertised: their descriptions ask the agent to use them as its canonical
 * to-do list, which a host that tracks work its own way does not want (#4606).
 */
export function withoutDisabledWorkStateTools<T extends { name: string }>(
  advertisedTools: readonly T[],
  workStateEnabled: boolean
): T[] {
  if (workStateEnabled) {
    return [...advertisedTools];
  }
  return advertisedTools.filter((tool) => !workStateToolNameSet.has(tool.name));
}

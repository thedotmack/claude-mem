import type { SelectedRuntime } from '../services/hooks/runtime-selector.js';

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
  if (runtime === 'server-beta') {
    return [...allTools];
  }
  return allTools.filter((tool) => !serverBetaOnlyToolNameSet.has(tool.name));
}

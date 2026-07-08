export const MCP_SERVER_KEY = 'mcp-search' as const;

export const MCP_TOOL_NAMES = {
  SEARCH: 'search',
  TIMELINE: 'timeline',
  GET_OBSERVATIONS: 'get_observations',
} as const;

export function buildToolSearchSelectArg(): string {
  const prefix = `mcp__${MCP_SERVER_KEY}__`;
  return [
    MCP_TOOL_NAMES.SEARCH,
    MCP_TOOL_NAMES.TIMELINE,
    MCP_TOOL_NAMES.GET_OBSERVATIONS,
  ].map(name => `${prefix}${name}`).join(',');
}

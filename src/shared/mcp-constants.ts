/**
 * Canonical MCP server registration key and primary tool names for claude-mem.
 *
 * The registration key must match the key in plugin/.mcp.json. Claude Code
 * prefixes every tool as `mcp__<server-key>__<tool-name>`, so both sides of
 * that contract are defined here to prevent silent drift.
 */
export const MCP_SERVER_KEY = 'mcp-search' as const;

export const MCP_TOOL_NAMES = {
  SEARCH: 'search',
  TIMELINE: 'timeline',
  GET_OBSERVATIONS: 'get_observations',
} as const;

/**
 * Returns the fully-qualified `ToolSearch select:` argument for the three
 * primary mem-search tools.
 */
export function buildToolSearchSelectArg(): string {
  const prefix = `mcp__${MCP_SERVER_KEY}__`;
  return [
    MCP_TOOL_NAMES.SEARCH,
    MCP_TOOL_NAMES.TIMELINE,
    MCP_TOOL_NAMES.GET_OBSERVATIONS,
  ].map(name => `${prefix}${name}`).join(',');
}

/** Lightweight classifiers shared by hooks, ingestion and raw tool storage. */
const RETRIEVAL_TOOLS = new Set([
  'mem_search', 'search', 'timeline', 'get_observations', 'get_summaries',
  'get_tool_uses', 'session_start_context', 'observation_search', 'observation_context',
  'memory_search', 'memory_context',
]);

function claudeMemToolName(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const parts = name.split('__');
  if (parts.length < 3) return null;
  const server = parts[1].toLowerCase();
  if (!server.includes('claude-mem') && !server.includes('claude_mem')
      && !server.includes('mcp-search') && !server.includes('mcp_search') && !server.includes('cmem')) return null;
  return parts.slice(2).join('__');
}

export function isRecursiveMemoryTool(toolName: string): boolean {
  if (!toolName) return false;
  // Preserve the OpenClaw adapter's existing native memory_* recursion gate.
  if (toolName.startsWith('memory_')) return true;
  if (toolName === 'mem_search' || toolName === 'get_summaries') return true;
  const tool = claudeMemToolName(toolName);
  return tool !== null && RETRIEVAL_TOOLS.has(tool);
}

/** Explicit notes are already durable; their tool echo must not buy another observation. */
export function isExplicitMemoryWrite(toolName: string): boolean {
  return toolName === 'save_memory' || claudeMemToolName(toolName) === 'save_memory';
}

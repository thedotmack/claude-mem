/**
 * The one definition of claude-mem's tool identity, shared by the transcript
 * deliverables collector, auto-clear and the OpenCode adapter. The `[_.-]`
 * separator class is essential: `effectiveName()` joins with a single `_`,
 * Code Mode's `qualifiedName()` joins with a `.`, and the MCP bridge uses `__`.
 * No recoverable key list: repair is deliberately ruled out (S2).
 */

/** claude-mem's work-state write tool, however the host namespaces it. */
export const WORK_STATE_WRITE_TOOL = /(?:^|[_.-])work_state_write$/;

/** Any claude-mem tool that carries a namespace or a `claude_mem_*` prefix. */
export const CLAUDE_MEM_TOOL = /(?:^|[_.-])claude[-_]mem(?:[_.-]|$)/i;

/**
 * True for any claude-mem tool. Prefixed/namespaced forms are caught by
 * CLAUDE_MEM_TOOL; the bare `work_state_write` MCP name carries no namespace
 * and is caught by WORK_STATE_WRITE_TOOL. The server's other tool names are
 * not enumerated here.
 */
export function isClaudeMemTool(name: string): boolean {
  return CLAUDE_MEM_TOOL.test(name) || WORK_STATE_WRITE_TOOL.test(name);
}

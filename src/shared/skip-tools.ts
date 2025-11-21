/**
 * Tools to skip - ALWAYS skipped, even in Endless Mode "observe everything"
 * These tools don't produce compressible output useful for transcript compression
 */
export const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool',  // MCP infrastructure - no user-facing work
  'SlashCommand',          // Command invocation (observe what it produces, not the call)
  'Skill',                 // Skill invocation (observe what it produces, not the call)
  'TodoWrite',             // Task management meta-tool - internal tracking only
  'AskUserQuestion'        // User interaction - no substantive work to compress
]);

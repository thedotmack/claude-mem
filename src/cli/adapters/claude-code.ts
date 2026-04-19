import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Maps Claude Code stdin format (session_id, cwd, tool_name, etc.)
// SessionStart hooks receive no stdin, so we must handle undefined input gracefully

// Defensive cap: Claude Code's agent identifiers are short (e.g., "agent-abc123", "Explore").
// Ignore anything longer than 128 chars so a malformed payload cannot balloon DB rows.
const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path,
      agentId: pickAgentField(r.agent_id),
      agentType: pickAgentField(r.agent_type),
    };
  },
  formatOutput(result) {
    const r = result ?? ({} as HookResult);
    if (r.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: result.hookSpecificOutput };
      if (r.systemMessage) {
        output.systemMessage = r.systemMessage;
      }
      return output;
    }
    // Only emit fields in the Claude Code hook contract — unrecognized fields
    // cause "JSON validation failed" in Stop hooks.
    const output: Record<string, unknown> = {};
    if (r.systemMessage) {
      output.systemMessage = r.systemMessage;
    }
    return output;
  }
};

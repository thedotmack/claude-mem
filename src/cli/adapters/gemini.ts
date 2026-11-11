import { stripVTControlCharacters } from 'util';
import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const TOOL_NAMES: Record<string, string> = {
  read_file: 'Read', write_file: 'Write', replace: 'Edit', run_shell_command: 'Bash',
  list_directory: 'LS', glob: 'Glob', grep_search: 'Grep',
};

// Gemini CLI names MCP tools `mcp_<server>_<tool>`. For every server name
// isRecursiveMemoryTool recognizes (local claude-mem, CMEM Pro's `cmem` recall
// server), rewrite it as `mcp__<server>__<tool>` so claude-mem's own recall is
// never sent back to the observer. Longest first, so `mcp_claude_mem_` is not
// read as server `claude`.
const MEMORY_MCP_SERVERS = ['claude-mem', 'claude_mem', 'mcp-search', 'mcp_search', 'cmem']
  .sort((a, b) => b.length - a.length);

function normalizeToolName(nativeName: string | undefined): string | undefined {
  if (!nativeName) return nativeName;
  for (const server of MEMORY_MCP_SERVERS) {
    const prefix = `mcp_${server}_`;
    if (nativeName.startsWith(prefix) && nativeName.length > prefix.length) {
      return `mcp__${server}__${nativeName.slice(prefix.length)}`;
    }
  }
  return Object.hasOwn(TOOL_NAMES, nativeName) ? TOOL_NAMES[nativeName] : nativeName;
}

// Gemini CLI 0.44.1 exposes no tool-call ID in AfterTool. Do not manufacture
// one from arguments: two identical calls can be distinct live events.
export const geminiAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!isValidCwd(r.cwd)) throw new AdapterRejectedInput('invalid_cwd');
    if (!text(r.session_id)) throw new AdapterRejectedInput('missing_session_id');
    const toolName = normalizeToolName(text(r.tool_name));
    return {
      sessionId: r.session_id as string,
      cwd: r.cwd,
      platform: 'gemini',
      hookEventName: text(r.hook_event_name),
      prompt: text(r.prompt),
      toolName,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: text(r.transcript_path),
      lastAssistantMessage: text(r.prompt_response),
      reason: text(r.reason),
      sessionSource: r.source === 'startup' || r.source === 'resume' || r.source === 'clear' ? r.source : undefined,
    };
  },
  formatOutput(result: HookResult): unknown {
    // Capture must never deny a Gemini tool, retry a turn, or rewrite arguments.
    // systemMessage is shown in Gemini's terminal, so drop ANSI styling meant for other hosts.
    const output: Record<string, unknown> = {};
    const context = result.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string' && context.length > 0) output.hookSpecificOutput = { additionalContext: context };
    const message = typeof result.systemMessage === 'string' ? stripVTControlCharacters(result.systemMessage) : '';
    if (message.length > 0) output.systemMessage = message;
    return output;
  },
};

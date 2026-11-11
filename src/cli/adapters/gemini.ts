import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const TOOL_NAMES: Record<string, string> = {
  read_file: 'Read', write_file: 'Write', replace: 'Edit', run_shell_command: 'Bash',
  list_directory: 'LS', glob: 'Glob', grep_search: 'Grep',
};

// Gemini CLI 0.44.1 exposes no tool-call ID in AfterTool. Do not manufacture
// one from arguments: two identical calls can be distinct live events.
export const geminiAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!isValidCwd(r.cwd)) throw new AdapterRejectedInput('invalid_cwd');
    if (!text(r.session_id)) throw new AdapterRejectedInput('missing_session_id');
    const nativeName = text(r.tool_name);
    const toolName = nativeName?.startsWith('mcp_claude-mem_')
      ? `mcp__claude-mem__${nativeName.slice('mcp_claude-mem_'.length)}`
      : nativeName && (Object.hasOwn(TOOL_NAMES, nativeName) ? TOOL_NAMES[nativeName] : nativeName);
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
    const context = result.hookSpecificOutput?.additionalContext;
    return typeof context === 'string' && context.length > 0
      ? { hookSpecificOutput: { additionalContext: context } }
      : {};
  },
};
